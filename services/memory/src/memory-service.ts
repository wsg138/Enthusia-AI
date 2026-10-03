/**
 * @enthusia/memory — current memory + historical revisions service (W05).
 *
 * Implements MASTER-SPECIFICATION.md §§13, 49 and
 * MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md (the memory bible).
 *
 * Primary invariant (NON-NEGOTIABLE): old stale values must NOT remain in
 * normal current retrieval. When fact B supersedes fact A, B becomes CURRENT,
 * A becomes SUPERSEDED, current lookup returns ONLY B, history returns both.
 *
 * Concurrency model:
 *  - per-key async mutex serializes operations on the same key within this process;
 *  - every mutating operation runs in a single `BEGIN IMMEDIATE` transaction,
 *    so concurrent connections/processes serialize at the database level;
 *  - a partial unique index (`uq_current_revision_per_key`) makes "two
 *    CURRENT revisions for one key" impossible even under races;
 *  - `expectedCurrentRevisionId` gives callers optimistic compare-and-set.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import {
  EvidenceRole,
  memoryEvidenceSchema,
  memoryKeySchema,
  SourceStatus,
  Visibility,
} from '@enthusia/contracts';
import { SCHEMA_DDL } from './schema.js';
import {
  ConcurrentModificationError,
  CurrentRevisionExistsError,
  MemoryKeyNotFoundError,
  MemoryRevisionNotFoundError,
  MemoryValidationError,
  NoActiveRevisionError,
} from './errors.js';
import type {
  CacheInvalidator,
  CorrectionInput,
  CreateRevisionInput,
  CurrentMemory,
  EvidenceInput,
  InvalidateInput,
  MemoryEvent,
  MemoryEventListener,
  MemoryEventType,
  MemoryRef,
  ReportConflictInput,
  StoredRevision,
  SupersedeInput,
} from './types.js';
import type { MemoryEvidence, MemoryKey, MemoryRevision } from './types.js';

interface KeyRow {
  id: string;
  namespace: string;
  key: string;
  scope: string;
  visibility: string;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  id: string;
  memory_key_id: string;
  value_json: string;
  summary: string;
  status: string;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
  verified_at: string | null;
  authority: string;
  reason: string | null;
  supersedes_revision_id: string | null;
  superseded_by_revision_id: string | null;
}

interface EvidenceRow {
  id: string;
  revision_id: string;
  source_artifact_id: string;
  source_version: string;
  evidence_role: string;
  observed_at: string | null;
  verified_at: string | null;
  authority_level: string | null;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function refLabel(ref: MemoryRef): string {
  return `${ref.namespace} | ${ref.key} | ${ref.scope}`;
}

function lockName(ref: MemoryRef): string {
  return `${ref.namespace}${ref.key}${ref.scope}`;
}

function validateRef(ref: MemoryRef): void {
  for (const [name, v] of [
    ['namespace', ref.namespace],
    ['key', ref.key],
    ['scope', ref.scope],
  ] as const) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new MemoryValidationError(`MemoryRef.${name} must be a non-empty string`);
    }
  }
}

export interface MemoryServiceOptions {
  /** SQLite path. Omit (or ':memory:') for an in-memory database. */
  path?: string;
}

export class MemoryService {
  private readonly db: Database.Database;
  private readonly emitter = new EventEmitter();
  private readonly invalidators = new Set<CacheInvalidator>();
  /** Per-key promise-chain mutex (in-process serialization). */
  private readonly keyLocks = new Map<string, Promise<void>>();

  private readonly stmtGetKey: Database.Statement;
  private readonly stmtGetKeyById: Database.Statement;
  private readonly stmtActiveRevision: Database.Statement;
  private readonly stmtRevisionById: Database.Statement;
  private readonly stmtEvidenceForRevision: Database.Statement;

  constructor(options: MemoryServiceOptions = {}) {
    this.db = new Database(options.path ?? ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_DDL);

    this.stmtGetKey = this.db.prepare(
      'SELECT * FROM memory_keys WHERE namespace = ? AND key = ? AND scope = ?',
    );
    this.stmtGetKeyById = this.db.prepare('SELECT * FROM memory_keys WHERE id = ?');
    this.stmtActiveRevision = this.db.prepare(
      `SELECT * FROM memory_revisions
        WHERE memory_key_id = ? AND status IN ('CURRENT','CONFLICTED','STALE')
        ORDER BY created_at DESC LIMIT 1`,
    );
    this.stmtRevisionById = this.db.prepare('SELECT * FROM memory_revisions WHERE id = ?');
    this.stmtEvidenceForRevision = this.db.prepare(
      'SELECT * FROM memory_evidence WHERE revision_id = ? ORDER BY created_at ASC',
    );
  }

  // ------------------------------------------------------------------ locks

  private async withKeyLock<T>(ref: MemoryRef, fn: () => T): Promise<T> {
    const name = lockName(ref);
    const previous = this.keyLocks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.keyLocks.set(name, current);
    await previous;
    try {
      return fn();
    } finally {
      release();
      if (this.keyLocks.get(name) === current) {
        this.keyLocks.delete(name);
      }
    }
  }

  /**
   * Run fn inside a single IMMEDIATE transaction and defer externally visible
   * post-commit work until COMMIT has succeeded.
   */
  private pendingAfterCommit: Array<() => void> | null = null;

  private inTransaction<T>(fn: () => T): T {
    if (this.pendingAfterCommit !== null) {
      throw new MemoryValidationError('Nested memory transactions are not supported');
    }

    this.db.exec('BEGIN IMMEDIATE');
    const callbacks: Array<() => void> = [];
    this.pendingAfterCommit = callbacks;

    let result: T;
    try {
      result = fn();
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ROLLBACK itself failing means the transaction is already gone.
      }
      this.pendingAfterCommit = null;
      throw err;
    }

    this.pendingAfterCommit = null;
    // The durable write has already committed. Observer failures must never
    // retroactively make a successful memory mutation appear to have failed.
    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        // Cache/event observers are best-effort side effects.
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- mapping

  private mapKey(row: KeyRow): MemoryKey {
    const key: MemoryKey = {
      id: row.id,
      namespace: row.namespace,
      key: row.key,
      scope: row.scope,
      visibility: row.visibility as Visibility,
    };
    memoryKeySchema.parse(key);
    return key;
  }

  private mapEvidence(row: EvidenceRow): MemoryEvidence {
    const evidence: MemoryEvidence = {
      id: row.id,
      revisionId: row.revision_id,
      sourceArtifactId: row.source_artifact_id,
      sourceVersion: row.source_version,
      evidenceRole: row.evidence_role as EvidenceRole,
    };
    memoryEvidenceSchema.parse(evidence);
    return evidence;
  }

  private mapRevision(row: RevisionRow, key: MemoryKey): StoredRevision {
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch (err) {
      throw new MemoryValidationError(`Revision ${row.id} has corrupt value_json`, {
        cause: err,
      });
    }
    const revision: MemoryRevision = {
      id: row.id,
      memoryKeyId: row.memory_key_id,
      value,
      summary: row.summary,
      status: row.status as MemoryRevision['status'],
      validFrom: row.valid_from,
      createdAt: row.created_at,
      authority: row.authority,
      evidenceReferences: [],
      ...(row.valid_to ? { validTo: row.valid_to } : {}),
      ...(row.verified_at ? { verifiedAt: row.verified_at } : {}),
      ...(row.supersedes_revision_id
        ? { supersedesRevisionId: row.supersedes_revision_id }
        : {}),
      ...(row.superseded_by_revision_id
        ? { supersededByRevisionId: row.superseded_by_revision_id }
        : {}),
    };
    const evidenceRows = this.stmtEvidenceForRevision.all(row.id) as EvidenceRow[];
    const evidence = evidenceRows.map((r) => this.mapEvidence(r));
    revision.evidenceReferences = evidence.map((e) => e.id);
    return { ...revision, key, evidence };
  }

  private getKeyRowOrThrow(ref: MemoryRef): KeyRow {
    validateRef(ref);
    const row = this.stmtGetKey.get(ref.namespace, ref.key, ref.scope) as KeyRow | undefined;
    if (!row) {
      throw new MemoryKeyNotFoundError(refLabel(ref));
    }
    return row;
  }

  private getActiveRow(keyId: string): RevisionRow | undefined {
    return this.stmtActiveRevision.get(keyId) as RevisionRow | undefined;
  }

  private insertEvidence(revisionId: string, inputs: EvidenceInput[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO memory_evidence
         (id, revision_id, source_artifact_id, source_version, evidence_role,
          observed_at, verified_at, authority_level, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const at = nowIso();
    for (const input of inputs) {
      if (!input.sourceArtifactId || !input.sourceVersion) {
        throw new MemoryValidationError('Evidence requires sourceArtifactId and sourceVersion');
      }
      stmt.run(
        randomUUID(),
        revisionId,
        input.sourceArtifactId,
        input.sourceVersion,
        input.evidenceRole,
        input.observedAt ?? null,
        input.verifiedAt ?? null,
        input.authorityLevel ?? null,
        at,
      );
    }
  }

  private recordEvent(
    type: MemoryEventType,
    key: MemoryKey,
    revisionId: string | null,
    payload: Record<string, unknown>,
  ): MemoryEvent {
    const event: MemoryEvent = {
      type,
      key,
      revisionId,
      payload,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO memory_events (id, event_type, memory_key_id, revision_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), type, key.id, revisionId, JSON.stringify(payload), event.createdAt);
    return event;
  }

  private afterCommit(ref: MemoryRef, revisionId: string, event: MemoryEvent): void {
    const notify = (): void => {
      for (const invalidate of this.invalidators) {
        try {
          invalidate(ref, revisionId);
        } catch {
          // An invalidator must never break the committed memory write.
        }
      }

      // EventEmitter propagates listener exceptions by default. These events
      // are notifications about an already-durable write, so a faulty
      // observer must not turn successful persistence into an apparent
      // mutation failure.
      try {
        this.emitter.emit(event.type, event);
      } catch {
        // Best-effort observer.
      }
      try {
        this.emitter.emit('memory.changed', event);
      } catch {
        // Best-effort observer.
      }
    };

    if (this.pendingAfterCommit !== null) {
      this.pendingAfterCommit.push(notify);
      return;
    }
    notify();
  }

  // ------------------------------------------------------------ key management

  /**
   * Get the memory key for (namespace, key, scope), creating it if needed.
   * The key identifies the concept, not a particular value (§3).
   */
  ensureKey(ref: MemoryRef, visibility: Visibility = Visibility.STAFF): MemoryKey {
    validateRef(ref);
    const existing = this.stmtGetKey.get(ref.namespace, ref.key, ref.scope) as
      | KeyRow
      | undefined;
    if (existing) {
      return this.mapKey(existing);
    }
    const at = nowIso();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_keys (id, namespace, key, scope, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ref.namespace, ref.key, ref.scope, visibility, at, at);
    return this.mapKey((this.stmtGetKeyById.get(id) as KeyRow | undefined)!);
  }

  /** Look up a key without creating it; returns null when absent. */
  findKey(ref: MemoryRef): MemoryKey | null {
    validateRef(ref);
    const row = this.stmtGetKey.get(ref.namespace, ref.key, ref.scope) as KeyRow | undefined;
    return row ? this.mapKey(row) : null;
  }

  // --------------------------------------------------------------- revisions

  /**
   * Create the FIRST revision for a key. Fails with CurrentRevisionExistsError
   * if the key already has an active revision — replace it with supersede().
   */
  async createRevision(input: CreateRevisionInput): Promise<CurrentMemory> {
    const ref: MemoryRef = {
      namespace: input.namespace,
      key: input.key,
      scope: input.scope,
    };
    return this.withKeyLock(ref, () => {
      const key = this.ensureKey(ref, input.visibility ?? Visibility.STAFF);
      return this.inTransaction(() => {
        if (!input.summary || !input.authority) {
          throw new MemoryValidationError('createRevision requires summary and authority');
        }
        const active = this.getActiveRow(key.id);
        if (active) {
          throw new CurrentRevisionExistsError(refLabel(ref));
        }
        const at = nowIso();
        const revisionId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO memory_revisions
               (id, memory_key_id, value_json, summary, status, valid_from, valid_to,
                created_at, verified_at, authority, reason,
                supersedes_revision_id, superseded_by_revision_id)
             VALUES (?, ?, ?, ?, 'CURRENT', ?, NULL, ?, NULL, ?, NULL, NULL, NULL)`,
          )
          .run(
            revisionId,
            key.id,
            JSON.stringify(input.value),
            input.summary,
            input.validFrom ?? at,
            at,
            input.authority,
          );
        this.insertEvidence(revisionId, input.evidence ?? []);
        // §5 step 8: index the new CURRENT revision.
        this.db
          .prepare(
            `INSERT INTO memory_current_index (memory_key_id, revision_id, summary, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(key.id, revisionId, input.summary, at);
        this.db
          .prepare('UPDATE memory_keys SET updated_at = ? WHERE id = ?')
          .run(at, key.id);
        const event = this.recordEvent('memory.created', key, revisionId, {
          summary: input.summary,
          authority: input.authority,
        });
        const stored = this.mapRevision(
          this.stmtRevisionById.get(revisionId) as RevisionRow,
          key,
        );
        const result: CurrentMemory = { key, revision: stored };
        this.afterCommit(ref, revisionId, event);
        return result;
      });
    });
  }

  /**
   * Default current retrieval (§13): returns ONLY the CURRENT revision.
   * SUPERSEDED, INVALID and STALE revisions are never returned here.
   * A CONFLICTED revision is returned only when `includeConflicted` is set —
   * normal answers must not treat it as a verified fact (§13.5, §16).
   */
  getCurrent(
    ref: MemoryRef,
    options: { includeConflicted?: boolean } = {},
  ): CurrentMemory | null {
    validateRef(ref);
    const keyRow = this.stmtGetKey.get(ref.namespace, ref.key, ref.scope) as
      | KeyRow
      | undefined;
    if (!keyRow) {
      return null;
    }
    const key = this.mapKey(keyRow);
    // Read through the materialized current index (§5 steps 8–9, §15): the
    // superseded revision is removed from this index, never merely relabeled.
    const indexRow = this.db
      .prepare('SELECT revision_id FROM memory_current_index WHERE memory_key_id = ?')
      .get(key.id) as { revision_id: string } | undefined;
    if (indexRow) {
      const revisionRow = this.stmtRevisionById.get(indexRow.revision_id) as
        | RevisionRow
        | undefined;
      if (revisionRow && revisionRow.status === SourceStatus.CURRENT) {
        return { key, revision: this.mapRevision(revisionRow, key) };
      }
      // Defensive: index and revision table disagree — never leak a
      // non-CURRENT row as current.
      return null;
    }
    if (options.includeConflicted) {
      const active = this.getActiveRow(key.id);
      if (active && active.status === SourceStatus.CONFLICTED) {
        return { key, revision: this.mapRevision(active, key) };
      }
    }
    return null;
  }

  /** Fetch one revision by id (any status) with its key and evidence. */
  getRevision(revisionId: string): StoredRevision {
    const row = this.stmtRevisionById.get(revisionId) as RevisionRow | undefined;
    if (!row) {
      throw new MemoryRevisionNotFoundError(revisionId);
    }
    const keyRow = this.stmtGetKeyById.get(row.memory_key_id) as KeyRow | undefined;
    if (!keyRow) {
      throw new MemoryKeyNotFoundError(row.memory_key_id);
    }
    return this.mapRevision(row, this.mapKey(keyRow));
  }

  // ------------------------------------------------------------ supersession

  /**
   * Atomic supersession (MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §5):
   *
   *  1. lock memory key (per-key mutex + BEGIN IMMEDIATE);
   *  2. verify expected current revision when the caller passes one
   *     (compare-and-set; mismatch → ConcurrentModificationError);
   *  3. create B as CURRENT;
   *  4. mark A CURRENT/CONFLICTED/STALE → SUPERSEDED;
   *  5. link A.superseded_by = B and B.supersedes = A;
   *  6. replace A with B in the current index (never just relabel);
   *  7. run registered cache invalidators;
   *  8. emit memory.superseded + memory.changed.
   *
   * The partial unique index makes it impossible to expose two CURRENT
   * revisions for one key, even under concurrent writers.
   */
  async supersede(input: SupersedeInput): Promise<{ key: MemoryKey; previous: StoredRevision; current: StoredRevision }> {
    const ref: MemoryRef = {
      namespace: input.namespace,
      key: input.key,
      scope: input.scope,
    };
    return this.withKeyLock(ref, () => {
      const keyRow = this.getKeyRowOrThrow(ref);
      const key = this.mapKey(keyRow);
      return this.inTransaction(() => {
        if (!input.summary || !input.authority) {
          throw new MemoryValidationError('supersede requires summary and authority');
        }
        const active = this.getActiveRow(key.id);
        if (!active) {
          throw new NoActiveRevisionError(refLabel(ref));
        }
        if (
          input.expectedCurrentRevisionId !== undefined &&
          active.id !== input.expectedCurrentRevisionId
        ) {
          throw new ConcurrentModificationError(input.expectedCurrentRevisionId, active.id);
        }

        const at = nowIso();
        const nextId = randomUUID();

        // 4. Mark A CURRENT/CONFLICTED -> SUPERSEDED FIRST. The partial
        // unique index forbids two CURRENT rows for one key even transiently
        // inside the transaction, so A must step down before B is inserted.
        // Readers never see the intermediate state: BEGIN IMMEDIATE holds the
        // write lock and uncommitted rows are invisible to other connections.
        this.db
          .prepare(
            `UPDATE memory_revisions
                SET status = 'SUPERSEDED', valid_to = ?, superseded_by_revision_id = ?
              WHERE id = ?`,
          )
          .run(at, nextId, active.id);

        // 3. Create B as CURRENT. (Inserting first would trip the
        // uq_current_revision_per_key index while A is still CURRENT.)
        this.db
          .prepare(
            `INSERT INTO memory_revisions
               (id, memory_key_id, value_json, summary, status, valid_from, valid_to,
                created_at, verified_at, authority, reason,
                supersedes_revision_id, superseded_by_revision_id)
             VALUES (?, ?, ?, ?, 'CURRENT', ?, NULL, ?, NULL, ?, ?, ?, NULL)`,
          )
          .run(
            nextId,
            key.id,
            JSON.stringify(input.value),
            input.summary,
            input.validFrom ?? at,
            at,
            input.authority,
            input.reason ?? null,
            active.id,
          );

        // 5. Linkage: A.superseded_by = B and B.supersedes = A (both ways).
        const previous = this.mapRevision(
          this.stmtRevisionById.get(active.id) as RevisionRow,
          key,
        );

        // 6. Current index: remove A, index B (§5 steps 8–9, §15).
        this.db
          .prepare('DELETE FROM memory_current_index WHERE memory_key_id = ?')
          .run(key.id);
        this.db
          .prepare(
            `INSERT INTO memory_current_index (memory_key_id, revision_id, summary, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(key.id, nextId, input.summary, at);

        // Evidence: new evidence for B; optionally carry A's evidence forward
        // so current retrieval keeps the provenance chain. A's own evidence
        // rows are untouched — history always retains them.
        const inherited: EvidenceInput[] = [];
        if (input.inheritEvidence) {
          for (const ev of previous.evidence) {
            inherited.push({
              sourceArtifactId: ev.sourceArtifactId,
              sourceVersion: ev.sourceVersion,
              evidenceRole: ev.evidenceRole,
            });
          }
        }
        this.insertEvidence(nextId, [...inherited, ...(input.evidence ?? [])]);

        this.db
          .prepare('UPDATE memory_keys SET updated_at = ? WHERE id = ?')
          .run(at, key.id);

        const event = this.recordEvent('memory.superseded', key, nextId, {
          previousRevisionId: active.id,
          previousStatus: active.status,
          reason: input.reason ?? null,
          authority: input.authority,
        });

        const current = this.mapRevision(
          this.stmtRevisionById.get(nextId) as RevisionRow,
          key,
        );
        const result = { key, previous, current };
        // 7–8. Invalidate dependent caches, then emit.
        this.afterCommit(ref, nextId, event);
        return result;
      });
    });
  }

  // ------------------------------------------------- invalidation and states

  /**
   * Mark the active revision INVALID with no replacement (§13.4): removed
   * from current retrieval, retained in history, no replacement invented.
   */
  async invalidate(input: InvalidateInput): Promise<StoredRevision> {
    const ref: MemoryRef = {
      namespace: input.namespace,
      key: input.key,
      scope: input.scope,
    };
    return this.withKeyLock(ref, () => {
      const keyRow = this.getKeyRowOrThrow(ref);
      const key = this.mapKey(keyRow);
      return this.inTransaction(() => {
        const active = this.getActiveRow(key.id);
        if (!active) {
          throw new NoActiveRevisionError(refLabel(ref));
        }
        const at = nowIso();
        this.db
          .prepare(
            `UPDATE memory_revisions
                SET status = 'INVALID', valid_to = ?, reason = ?
              WHERE id = ?`,
          )
          .run(at, input.reason, active.id);
        this.db
          .prepare('DELETE FROM memory_current_index WHERE memory_key_id = ?')
          .run(key.id);
        this.db
          .prepare('UPDATE memory_keys SET updated_at = ? WHERE id = ?')
          .run(at, key.id);
        const event = this.recordEvent('memory.invalidated', key, active.id, {
          reason: input.reason,
          authority: input.authority,
        });
        const stored = this.mapRevision(
          this.stmtRevisionById.get(active.id) as RevisionRow,
          key,
        );
        this.afterCommit(ref, active.id, event);
        return stored;
      });
    });
  }

  /**
   * Mark the active revision STALE (§12): its source can no longer be proven
   * current. Removed from current retrieval until re-verified or superseded.
   */
  async markStale(
    ref: MemoryRef,
    options: { reason: string; authority: string },
  ): Promise<StoredRevision> {
    return this.withKeyLock(ref, () => {
      const keyRow = this.getKeyRowOrThrow(ref);
      const key = this.mapKey(keyRow);
      return this.inTransaction(() => {
        const active = this.getActiveRow(key.id);
        if (!active) {
          throw new NoActiveRevisionError(refLabel(ref));
        }
        const at = nowIso();
        this.db
          .prepare(
            `UPDATE memory_revisions
                SET status = 'STALE', reason = ?
              WHERE id = ?`,
          )
          .run(options.reason, active.id);
        this.db
          .prepare('DELETE FROM memory_current_index WHERE memory_key_id = ?')
          .run(key.id);
        this.db
          .prepare('UPDATE memory_keys SET updated_at = ? WHERE id = ?')
          .run(at, key.id);
        const event = this.recordEvent('memory.staled', key, active.id, {
          reason: options.reason,
          authority: options.authority,
        });
        const stored = this.mapRevision(
          this.stmtRevisionById.get(active.id) as RevisionRow,
          key,
        );
        this.afterCommit(ref, active.id, event);
        return stored;
      });
    });
  }

  // ---------------------------------------------------------------- conflicts

  /**
   * Report conflicting authoritative evidence (§16, §13.5): the active
   * revision becomes CONFLICTED. The service never silently picks one side;
   * conflicting evidence is attached with the CONTRADICTING role and normal
   * current retrieval returns nothing until the conflict is resolved.
   */
  async reportConflict(input: ReportConflictInput): Promise<StoredRevision> {
    const ref: MemoryRef = {
      namespace: input.namespace,
      key: input.key,
      scope: input.scope,
    };
    return this.withKeyLock(ref, () => {
      const keyRow = this.getKeyRowOrThrow(ref);
      const key = this.mapKey(keyRow);
      return this.inTransaction(() => {
        if (!input.conflictingEvidence || input.conflictingEvidence.length === 0) {
          throw new MemoryValidationError(
            'reportConflict requires at least one conflicting evidence record',
          );
        }
        const active = this.getActiveRow(key.id);
        if (!active) {
          throw new NoActiveRevisionError(refLabel(ref));
        }
        const at = nowIso();
        this.db
          .prepare(
            `UPDATE memory_revisions
                SET status = 'CONFLICTED', reason = ?
              WHERE id = ?`,
          )
          .run(input.note ?? 'Conflicting authoritative evidence reported', active.id);
        for (const ev of input.conflictingEvidence) {
          if (ev.evidenceRole !== EvidenceRole.CONTRADICTING) {
            throw new MemoryValidationError(
              'Conflicting evidence must use the CONTRADICTING role',
            );
          }
        }
        this.insertEvidence(active.id, input.conflictingEvidence);
        // A conflicted value is not verified current truth (§13, §16).
        this.db
          .prepare('DELETE FROM memory_current_index WHERE memory_key_id = ?')
          .run(key.id);
        this.db
          .prepare('UPDATE memory_keys SET updated_at = ? WHERE id = ?')
          .run(at, key.id);
        const event = this.recordEvent('memory.conflicted', key, active.id, {
          note: input.note ?? null,
          authority: input.authority,
          conflictingSources: input.conflictingEvidence.map((e) => ({
            sourceArtifactId: e.sourceArtifactId,
            sourceVersion: e.sourceVersion,
          })),
        });
        const stored = this.mapRevision(
          this.stmtRevisionById.get(active.id) as RevisionRow,
          key,
        );
        this.afterCommit(ref, active.id, event);
        return stored;
      });
    });
  }

  // ------------------------------------------------------------------ correct

  /**
   * Correction API (§18): accept a human/system correction, create a new
   * revision carrying the correction provenance (authority
   * `correction:<actor>`, actor + reason in the event), and atomically
   * supersede the old revision. Provenance is preserved, not erased.
   */
  async correct(input: CorrectionInput): Promise<{ key: MemoryKey; previous: StoredRevision; current: StoredRevision }> {
    const ref: MemoryRef = {
      namespace: input.namespace,
      key: input.key,
      scope: input.scope,
    };
    if (!input.actor || !input.reason) {
      throw new MemoryValidationError('correct requires actor and reason');
    }
    const result = await this.supersede({
      ...ref,
      value: input.value,
      summary: input.summary,
      authority: `correction:${input.actor}`,
      reason: `Correction by ${input.actor}: ${input.reason}`,
      inheritEvidence: true,
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    });
    return result;
  }

  /**
   * Restore a historical revision as the basis for a new CURRENT revision
   * (§21 memory.restored). History stays append-only: a NEW revision is
   * created (copying the old value), the active revision is superseded.
   */
  async restore(
    ref: MemoryRef,
    revisionId: string,
    options: { authority: string; reason?: string },
  ): Promise<{ key: MemoryKey; previous: StoredRevision; current: StoredRevision }> {
    const historical = this.getRevision(revisionId);
    if (
      historical.key.namespace !== ref.namespace ||
      historical.key.key !== ref.key ||
      historical.key.scope !== ref.scope
    ) {
      throw new MemoryValidationError(
        `Revision ${revisionId} does not belong to ${refLabel(ref)}`,
      );
    }
    return this.supersede({
      ...ref,
      value: historical.value,
      summary: historical.summary,
      authority: options.authority,
      reason: options.reason ?? `Restored revision ${revisionId}`,
      inheritEvidence: true,
    });
  }

  /**
   * Re-verify the active revision against its evidence (§21 memory.verified).
   */
  async verify(
    ref: MemoryRef,
    options: { authority: string },
  ): Promise<StoredRevision> {
    return this.withKeyLock(ref, () => {
      const keyRow = this.getKeyRowOrThrow(ref);
      const key = this.mapKey(keyRow);
      return this.inTransaction(() => {
        const active = this.getActiveRow(key.id);
        if (!active) {
          throw new NoActiveRevisionError(refLabel(ref));
        }
        const at = nowIso();
        const revalidated = active.status === SourceStatus.STALE;

        this.db
          .prepare(
            `UPDATE memory_revisions
                SET status = ?, verified_at = ?, reason = CASE WHEN ? THEN NULL ELSE reason END
              WHERE id = ?`,
          )
          .run(
            revalidated ? SourceStatus.CURRENT : active.status,
            at,
            revalidated ? 1 : 0,
            active.id,
          );

        if (revalidated) {
          this.db
            .prepare(
              `INSERT INTO memory_current_index (memory_key_id, revision_id, summary, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(memory_key_id) DO UPDATE SET
                 revision_id = excluded.revision_id,
                 summary = excluded.summary,
                 updated_at = excluded.updated_at`,
            )
            .run(key.id, active.id, active.summary, at);
        }

        const event = this.recordEvent('memory.verified', key, active.id, {
          authority: options.authority,
          revalidated,
        });
        const stored = this.mapRevision(
          this.stmtRevisionById.get(active.id) as RevisionRow,
          key,
        );
        this.afterCommit(ref, active.id, event);
        return stored;
      });
    });
  }

  // ------------------------------------------------------- history and search

  /**
   * Explicit historical retrieval (§14): every revision of the key,
   * newest first — CURRENT, SUPERSEDED, INVALID, CONFLICTED, STALE alike.
   */
  getHistory(ref: MemoryRef): StoredRevision[] {
    validateRef(ref);
    const keyRow = this.stmtGetKey.get(ref.namespace, ref.key, ref.scope) as
      | KeyRow
      | undefined;
    if (!keyRow) {
      throw new MemoryKeyNotFoundError(refLabel(ref));
    }
    const key = this.mapKey(keyRow);
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_revisions
          WHERE memory_key_id = ?
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(key.id) as RevisionRow[];
    return rows.map((row) => this.mapRevision(row, key));
  }

  /**
   * Current-only search (§13, §49): returns CURRENT revisions only.
   * SUPERSEDED / INVALID / STALE / CONFLICTED are always excluded.
   */
  searchCurrent(filters: {
    namespace?: string;
    scope?: string;
    text?: string;
  } = {}): CurrentMemory[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.namespace !== undefined) {
      conditions.push('k.namespace = ?');
      params.push(filters.namespace);
    }
    if (filters.scope !== undefined) {
      conditions.push('k.scope = ?');
      params.push(filters.scope);
    }
    if (filters.text !== undefined) {
      conditions.push("(r.summary LIKE ? ESCAPE '\\' OR k.key LIKE ? ESCAPE '\\')");
      const like = `%${filters.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT k.*, r.id AS revision_id
           FROM memory_current_index i
           JOIN memory_keys k ON k.id = i.memory_key_id
           JOIN memory_revisions r ON r.id = i.revision_id
          ${where}
          ORDER BY k.namespace, k.key, k.scope`,
      )
      .all(...params) as (KeyRow & { revision_id: string })[];
    const out: CurrentMemory[] = [];
    for (const row of rows) {
      const revisionRow = this.stmtRevisionById.get(row.revision_id) as
        | RevisionRow
        | undefined;
      // Defensive: only ever surface verified-CURRENT rows.
      if (!revisionRow || revisionRow.status !== SourceStatus.CURRENT) {
        continue;
      }
      const key = this.mapKey(row);
      out.push({ key, revision: this.mapRevision(revisionRow, key) });
    }
    return out;
  }

  /**
   * Explicit historical search (§14): matches revisions of any status.
   * Used for audit, debugging, and "what did we used to believe" queries.
   */
  searchHistory(filters: {
    namespace?: string;
    scope?: string;
    text?: string;
    statuses?: MemoryRevision['status'][];
  } = {}): StoredRevision[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.namespace !== undefined) {
      conditions.push('k.namespace = ?');
      params.push(filters.namespace);
    }
    if (filters.scope !== undefined) {
      conditions.push('k.scope = ?');
      params.push(filters.scope);
    }
    if (filters.text !== undefined) {
      conditions.push("(r.summary LIKE ? ESCAPE '\\' OR k.key LIKE ? ESCAPE '\\')");
      const like = `%${filters.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    if (filters.statuses !== undefined && filters.statuses.length > 0) {
      conditions.push(`r.status IN (${filters.statuses.map(() => '?').join(', ')})`);
      params.push(...filters.statuses);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT r.*,
                k.id AS key_id, k.namespace AS key_namespace, k.key AS key_key,
                k.scope AS key_scope, k.visibility AS key_visibility,
                k.created_at AS key_created_at, k.updated_at AS key_updated_at
           FROM memory_revisions r
           JOIN memory_keys k ON k.id = r.memory_key_id
          ${where}
          ORDER BY r.created_at DESC, r.rowid DESC`,
      )
      .all(...params) as (RevisionRow & {
      key_id: string;
      key_namespace: string;
      key_key: string;
      key_scope: string;
      key_visibility: string;
      key_created_at: string;
      key_updated_at: string;
    })[];
    return rows.map((row) => {
      const key: MemoryKey = {
        id: row.key_id,
        namespace: row.key_namespace,
        key: row.key_key,
        scope: row.key_scope,
        visibility: row.key_visibility as Visibility,
      };
      return this.mapRevision(row, key);
    });
  }

  /** Evidence rows attached to one revision (survive supersession, §6). */
  getEvidenceForRevision(revisionId: string): MemoryEvidence[] {
    const row = this.stmtRevisionById.get(revisionId) as RevisionRow | undefined;
    if (!row) {
      throw new MemoryRevisionNotFoundError(revisionId);
    }
    return (this.stmtEvidenceForRevision.all(revisionId) as EvidenceRow[]).map((r) =>
      this.mapEvidence(r),
    );
  }

  // ------------------------------------------------------------------ events

  /** Subscribe to memory events (also persisted; see getEvents). */
  on(event: MemoryEventType | 'memory.changed', listener: MemoryEventListener): this {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: MemoryEventType | 'memory.changed', listener: MemoryEventListener): this {
    this.emitter.off(event, listener);
    return this;
  }

  /**
   * Register a cache invalidator (§22): called after every committed
   * mutation with the affected key, so dependent answer caches can drop
   * exactly the entries that depend on the changed revision.
   */
  registerCacheInvalidator(invalidator: CacheInvalidator): () => void {
    this.invalidators.add(invalidator);
    return () => {
      this.invalidators.delete(invalidator);
    };
  }

  /** Durable event log for a key, newest first (§21). */
  getEvents(ref: MemoryRef): MemoryEvent[] {
    const keyRow = this.getKeyRowOrThrow(ref);
    const rows = this.db
      .prepare(
        `SELECT event_type, revision_id, payload_json, created_at
           FROM memory_events
          WHERE memory_key_id = ?
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(keyRow.id) as {
      event_type: string;
      revision_id: string | null;
      payload_json: string;
      created_at: string;
    }[];
    const key = this.mapKey(keyRow);
    return rows.map((row) => ({
      type: row.event_type as MemoryEventType,
      key,
      revisionId: row.revision_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  /** Release the database handle. */
  close(): void {
    this.db.close();
  }
}
