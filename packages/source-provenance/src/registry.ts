/**
 * @enthusia/source-provenance — source registry.
 *
 * The canonical model for where facts came from. Owns:
 * - CRUD for source artifacts;
 * - current/superseded state transitions (atomic);
 * - queries by source type, component, visibility;
 * - per-locator history.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 30, 50, 54;
 * MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §§2.1, 10.
 *
 * Key behaviors:
 * - Registering a new source artifact makes it CURRENT.
 * - Registering an updated version (new hash) of the same source locator
 *   atomically supersedes the old CURRENT artifact: old -> SUPERSEDED,
 *   new -> CURRENT, in one transaction. The old artifact remains as
 *   historical evidence.
 * - Re-registering an unchanged version (same normalized hash) is a no-op:
 *   per §12.2, "when the fingerprint is unchanged, keep the current index".
 * - markInvalid moves an artifact to INVALID (terminal); it is never
 *   returned as current again.
 */

import { createHash } from 'node:crypto';
import {
  SourceStatus,
  SourceType,
  Visibility,
  canDisclose,
  sourceArtifactSchema,
  type ContentMetadata,
  type SourceArtifact,
} from '@enthusia/contracts';
import {
  ArtifactNotFoundError,
  InvalidTransitionError,
  SecretDenyRejectedError,
  SourceRegistryError,
} from './errors.js';
import { assignVisibility, type AssignVisibilityOptions } from './visibility.js';
import { assertLocatorMatchesType } from './locator.js';
import { compareVersions, isVersionChanged, normalizeVersion } from './version.js';
import { isLatestStatus, transitionStatus, type LifecycleEvent } from './lifecycle.js';
import { SourceProvenanceStore, rowToArtifact, type ArtifactRow, type StoredSourceArtifact } from './store.js';

export type { StoredSourceArtifact };

export interface RegisterArtifactInput {
  sourceType: SourceType;
  /** Version-independent source identity, e.g. 'github:wsg138/EnthusiaStaff:config.yml'. */
  sourceLocator: string;
  /** Subsystem that produced/owns the artifact (e.g. 'knowledge-indexer'). */
  component: string;
  /** Who/what asserts this artifact (e.g. 'github:wsg138/EnthusiaStaff'). */
  authority: string;
  /** Version or content hash of the source at observation time. */
  version: string;
  /** ISO 8601 observed time; defaults to now. */
  observedTime?: string;
  /** Explicit visibility. Required unless useDefaultVisibility is set. */
  visibility?: Visibility;
  /** Opt in to the conservative per-source-type default visibility. */
  useDefaultVisibility?: boolean;
  contentMetadata?: ContentMetadata;
  parserVersion?: string;
  embeddingVersion?: string;
}

export type RegisterOutcome = 'CREATED' | 'UNCHANGED' | 'SUPERSEDED';

export interface RegisterResult {
  artifact: StoredSourceArtifact;
  outcome: RegisterOutcome;
  /** Set when outcome is SUPERSEDED: the artifact that was replaced. */
  supersededArtifactId?: string;
}

export interface CurrentArtifactFilter {
  sourceType?: SourceType;
  component?: string;
  /** Exact visibility match. */
  visibility?: Visibility;
  /**
   * Disclosure ceiling: only artifacts disclosable under this ceiling are
   * returned (uses the contract's canDisclose; PLAYER_SELF additionally
   * needs isSubject/isStaff).
   */
  visibilityCeiling?: Visibility;
  isSubject?: boolean;
  isStaff?: boolean;
}

export interface UpdateMetadataInput {
  visibility?: Visibility;
  component?: string;
  authority?: string;
  contentMetadata?: ContentMetadata;
  parserVersion?: string;
  embeddingVersion?: string;
}

/**
 * Deterministic artifact identity: the same (locator, normalized version)
 * always maps to the same artifact id, which makes re-registration of an
 * unchanged source idempotent.
 */
export function deriveArtifactId(sourceLocator: string, version: string): string {
  const digest = createHash('sha256')
    .update(`${sourceLocator}\n${normalizeVersion(version)}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `art_${digest}`;
}

const nowIso = (): string => new Date().toISOString();

export class SourceRegistry {
  private readonly store: SourceProvenanceStore;

  constructor(store: SourceProvenanceStore) {
    this.store = store;
  }

  // ------------------------------------------------------------------ write

  /**
   * Register a source artifact.
   *
   * - Unknown locator -> the artifact becomes CURRENT (outcome CREATED).
   * - Same locator, unchanged version -> no-op, existing artifact returned
   *   (outcome UNCHANGED).
   * - Same locator, changed version -> atomic supersession: the old CURRENT
   *   artifact becomes SUPERSEDED (kept as history) and the new artifact
   *   becomes CURRENT (outcome SUPERSEDED).
   */
  register(input: RegisterArtifactInput): RegisterResult {
    assertLocatorMatchesType(input.sourceLocator, input.sourceType);
    const visibilityOptions: AssignVisibilityOptions = { sourceType: input.sourceType };
    if (input.visibility !== undefined) visibilityOptions.explicit = input.visibility;
    if (input.useDefaultVisibility !== undefined) {
      visibilityOptions.useDefault = input.useDefaultVisibility;
    }
    const visibility = assignVisibility(visibilityOptions);
    if (visibility === Visibility.SECRET_DENY) {
      // Defense in depth: assignVisibility already rejects this.
      throw new SecretDenyRejectedError(input.sourceLocator);
    }

    const observedTime = input.observedTime ?? nowIso();
    const artifactId = deriveArtifactId(input.sourceLocator, input.version);
    const base: SourceArtifact = {
      artifactId,
      sourceType: input.sourceType,
      sourceLocator: input.sourceLocator,
      component: input.component,
      visibility,
      authority: input.authority,
      version: input.version,
      observedTime,
      indexedTime: nowIso(),
      current: true,
    };
    if (input.contentMetadata !== undefined) base.contentMetadata = input.contentMetadata;
    if (input.parserVersion !== undefined) base.parserVersion = input.parserVersion;
    if (input.embeddingVersion !== undefined) base.embeddingVersion = input.embeddingVersion;
    // Validate against the contract schema before touching the store.
    sourceArtifactSchema.parse(base);

    // Idempotency: this exact (locator, version) was already registered.
    // The locator check matters: artifactId is derived from (locator,
    // version), so a row with the same id but a different locator can only
    // exist via out-of-band writes and must not short-circuit registration.
    const identical = this.getByIdOrUndefined(artifactId);
    if (identical !== undefined && identical.sourceLocator === input.sourceLocator) {
      return { artifact: identical, outcome: 'UNCHANGED' };
    }

    const previous = this.getCurrent(input.sourceLocator);
    if (previous === undefined || !isVersionChanged(previous.version, input.version)) {
      // No previous artifact, or same normalized version under a different
      // artifact id (should not happen given deterministic ids, but be
      // safe): insert without superseding.
      const artifact = this.insertArtifact(base, SourceStatus.CURRENT, undefined);
      return { artifact, outcome: 'CREATED' };
    }

    // Atomic supersession: exactly one latest artifact per locator at all
    // times. The transaction rolls back completely if either the UPDATE of
    // the old artifact or the INSERT of the new one fails.
    const supersede = this.store.db.transaction(() => {
      this.applyTransition(previous.artifactId, 'SUPERSEDE', { supersededBy: artifactId });
      return this.insertArtifact(base, SourceStatus.CURRENT, undefined);
    });
    let artifact: StoredSourceArtifact;
    try {
      artifact = supersede();
    } catch (error) {
      throw new SourceRegistryError(
        'SUPERSESSION_FAILED',
        `atomic supersession failed for locator ${input.sourceLocator}: old artifact ${previous.artifactId} left untouched`,
        { cause: error },
      );
    }
    return { artifact, outcome: 'SUPERSEDED', supersededArtifactId: previous.artifactId };
  }

  /**
   * Mark an artifact INVALID: the source was deleted or is no longer
   * trustworthy. INVALID is terminal and the artifact is no longer current.
   */
  markInvalid(artifactId: string): StoredSourceArtifact {
    return this.applyTransition(artifactId, 'INVALIDATE');
  }

  /** Mark a CURRENT artifact STALE: its version can no longer be proven current. */
  markStale(artifactId: string): StoredSourceArtifact {
    return this.applyTransition(artifactId, 'MARK_STALE');
  }

  /** A STALE artifact was verified against the live source: back to CURRENT. */
  revalidate(artifactId: string, observedTime: string = nowIso()): StoredSourceArtifact {
    const artifact = this.getById(artifactId);
    const next = transitionStatus(artifact.status, 'REVALIDATE');
    this.store.db
      .prepare(
        'UPDATE source_artifacts SET status = ?, is_current = 1, observed_time = ?, updated_at = ? WHERE artifact_id = ?',
      )
      .run(next, observedTime, nowIso(), artifactId);
    return this.getById(artifactId);
  }

  /** Authoritative evidence disagrees and no precedence rule resolves it. */
  reportConflict(artifactId: string): StoredSourceArtifact {
    return this.applyTransition(artifactId, 'REPORT_CONFLICT');
  }

  /** A CONFLICTED artifact was resolved: back to CURRENT. */
  resolveConflict(artifactId: string): StoredSourceArtifact {
    return this.applyTransition(artifactId, 'RESOLVE_CONFLICT');
  }

  /**
   * Correct mutable metadata (visibility, component, authority, parser info)
   * without changing the version. The artifact keeps its status and history.
   */
  updateMetadata(artifactId: string, input: UpdateMetadataInput): StoredSourceArtifact {
    const artifact = this.getById(artifactId);
    if (input.visibility === Visibility.SECRET_DENY) {
      throw new SecretDenyRejectedError(artifact.sourceLocator);
    }
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [nowIso()];
    if (input.visibility !== undefined) {
      sets.push('visibility = ?');
      params.push(input.visibility);
    }
    if (input.component !== undefined) {
      sets.push('component = ?');
      params.push(input.component);
    }
    if (input.authority !== undefined) {
      sets.push('authority = ?');
      params.push(input.authority);
    }
    if (input.contentMetadata !== undefined) {
      sets.push('content_metadata = ?');
      params.push(JSON.stringify(input.contentMetadata));
    }
    if (input.parserVersion !== undefined) {
      sets.push('parser_version = ?');
      params.push(input.parserVersion);
    }
    if (input.embeddingVersion !== undefined) {
      sets.push('embedding_version = ?');
      params.push(input.embeddingVersion);
    }
    params.push(artifactId);
    this.store.db
      .prepare(`UPDATE source_artifacts SET ${sets.join(', ')} WHERE artifact_id = ?`)
      .run(...params);
    return this.getById(artifactId);
  }

  // ------------------------------------------------------------------- read

  /** Fetch an artifact by id. Throws ArtifactNotFoundError when unknown. */
  getById(artifactId: string): StoredSourceArtifact {
    const artifact = this.getByIdOrUndefined(artifactId);
    if (artifact === undefined) throw new ArtifactNotFoundError(artifactId);
    return artifact;
  }

  /** The latest artifact for a locator, or undefined when there is none.
   *
   * This is the head of the locator's history — its `status` tells you
   * whether it is trustworthy (CURRENT) or not (STALE/CONFLICTED). Retrieval
   * paths that need only verified facts should use `listCurrent` instead.
   */
  getCurrent(sourceLocator: string): StoredSourceArtifact | undefined {
    const row = this.store.db
      .prepare(
        'SELECT * FROM source_artifacts WHERE source_locator = ? AND is_current = 1 LIMIT 1',
      )
      .get(sourceLocator) as ArtifactRow | undefined;
    return row === undefined ? undefined : rowToArtifact(row);
  }

  /**
   * List trusted CURRENT artifacts, optionally filtered by source type,
   * component, exact visibility, and/or a disclosure ceiling.
   *
   * STALE and CONFLICTED heads are excluded: per the contract they must not
   * be used as verified facts. Use `getCurrent`/`history` to inspect those.
   */
  listCurrent(filter: CurrentArtifactFilter = {}): StoredSourceArtifact[] {
    const clauses: string[] = ['is_current = 1', 'status = ?'];
    const params: unknown[] = [SourceStatus.CURRENT];
    if (filter.sourceType !== undefined) {
      clauses.push('source_type = ?');
      params.push(filter.sourceType);
    }
    if (filter.component !== undefined) {
      clauses.push('component = ?');
      params.push(filter.component);
    }
    if (filter.visibility !== undefined) {
      clauses.push('visibility = ?');
      params.push(filter.visibility);
    }
    const rows = this.store.db
      .prepare(
        `SELECT * FROM source_artifacts WHERE ${clauses.join(' AND ')} ORDER BY indexed_time DESC, rowid DESC`,
      )
      .all(...params);
    let artifacts = (rows as ArtifactRow[]).map((r) => rowToArtifact(r));
    if (filter.visibilityCeiling !== undefined) {
      const ceiling = filter.visibilityCeiling;
      const discloseOpts: { isSubject?: boolean; isStaff?: boolean } = {};
      if (filter.isSubject !== undefined) discloseOpts.isSubject = filter.isSubject;
      if (filter.isStaff !== undefined) discloseOpts.isStaff = filter.isStaff;
      artifacts = artifacts.filter((a) => canDisclose(a.visibility, ceiling, discloseOpts));
    }
    return artifacts;
  }

  /** Full history for a source locator, newest first. */
  history(sourceLocator: string): StoredSourceArtifact[] {
    const rows = this.store.db
      .prepare(
        'SELECT * FROM source_artifacts WHERE source_locator = ? ORDER BY indexed_time DESC, rowid DESC',
      )
      .all(sourceLocator) as ArtifactRow[];
    return rows.map((r) => rowToArtifact(r));
  }

  /** Artifact counts per status. Useful for monitoring/reconciliation. */
  stats(): Record<SourceStatus, number> {
    const counts: Record<SourceStatus, number> = {
      [SourceStatus.CURRENT]: 0,
      [SourceStatus.SUPERSEDED]: 0,
      [SourceStatus.INVALID]: 0,
      [SourceStatus.CONFLICTED]: 0,
      [SourceStatus.STALE]: 0,
    };
    const rows = this.store.db
      .prepare('SELECT status, COUNT(*) AS n FROM source_artifacts GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    for (const row of rows) {
      const status = row.status as SourceStatus;
      if (status in counts) counts[status] = row.n;
    }
    return counts;
  }

  /** Expose the version comparison used at registration (diagnostics). */
  versionComparison(a: string, b: string) {
    return compareVersions(a, b);
  }

  // ---------------------------------------------------------------- internal

  private getByIdOrUndefined(artifactId: string): StoredSourceArtifact | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM source_artifacts WHERE artifact_id = ?')
      .get(artifactId) as ArtifactRow | undefined;
    return row === undefined ? undefined : rowToArtifact(row);
  }

  private insertArtifact(
    artifact: SourceArtifact,
    status: SourceStatus,
    supersededBy: string | undefined,
  ): StoredSourceArtifact {
    const timestamp = nowIso();
    this.store.db
      .prepare(
        `INSERT INTO source_artifacts (
           artifact_id, source_type, source_locator, component, visibility,
           authority, version, observed_time, indexed_time, status, is_current,
           superseded_by, content_metadata, parser_version, embedding_version,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.artifactId,
        artifact.sourceType,
        artifact.sourceLocator,
        artifact.component,
        artifact.visibility,
        artifact.authority,
        artifact.version,
        artifact.observedTime,
        artifact.indexedTime,
        status,
        // A newly inserted artifact is always the head of its locator's history.
        1,
        supersededBy ?? null,
        artifact.contentMetadata !== undefined ? JSON.stringify(artifact.contentMetadata) : null,
        artifact.parserVersion ?? null,
        artifact.embeddingVersion ?? null,
        timestamp,
        timestamp,
      );
    const stored = this.getById(artifact.artifactId);
    return stored;
  }

  private applyTransition(
    artifactId: string,
    event: LifecycleEvent,
    options: { supersededBy?: string } = {},
  ): StoredSourceArtifact {
    const artifact = this.getById(artifactId);
    const next = (() => {
      try {
        return transitionStatus(artifact.status, event);
      } catch {
        throw new InvalidTransitionError(artifactId, artifact.status, event);
      }
    })();
    const builder: string[] = ['status = ?', 'is_current = ?', 'updated_at = ?'];
    const params: unknown[] = [next, isLatestStatus(next) ? 1 : 0, nowIso()];
    if (options.supersededBy !== undefined) {
      builder.push('superseded_by = ?');
      params.push(options.supersededBy);
    }
    params.push(artifactId);
    this.store.db
      .prepare(`UPDATE source_artifacts SET ${builder.join(', ')} WHERE artifact_id = ?`)
      .run(...params);
    return this.getById(artifactId);
  }
}
