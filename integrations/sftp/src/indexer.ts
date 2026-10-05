/**
 * @enthusia/integration-sftp — incremental SFTP file indexer (W09).
 *
 * Walks allowlisted server roots over a guarded read-only SFTP client and
 * builds read-only knowledge in the W04 source registry + W07 retrieval
 * engine:
 *
 * - Every file gets a version-independent locator `sftp:<server>:<path>`
 *   and a version fingerprint `sha256:<hash>` (§12.2).
 * - Unchanged files are skipped WITHOUT re-reading them: the fast path
 *   compares (size, mtime) from the last indexed artifact's contentMetadata
 *   against stat, and the slow path compares the content hash. Either way,
 *   identical content is never re-parsed or re-indexed (§12.2).
 * - Changed files are re-read, re-registered (W04 atomically supersedes the
 *   old CURRENT artifact), and re-chunked into W07 with status propagation.
 * - Files deleted from the server are marked INVALID (history preserved,
 *   §13.4) and their chunks leave current retrieval.
 * - Denied paths are refused at every layer: the walk filters them before
 *   stat, the per-root `DenyGuardSftpClient` throws on any attempted
 *   access, and secret-looking content is refused by the parser.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 24; WORKER-EXECUTION-PLAN.md §12.
 */

import posixPath from 'node:path/posix';
import {
  SourceStatus,
  SourceType,
  type SourceArtifact,
  type Visibility,
} from '@enthusia/contracts';
import {
  assertAllowedPath,
  isDeniedPath,
  SecretDenyError,
  type DenyRule,
} from './deny.js';
import {
  PARSER_VERSION,
  fingerprintToVersion,
  prepareDocumentText,
  type PrepareOutcome,
} from './parsers.js';
import {
  DenyGuardSftpClient,
  SftpPathEscapeError,
  type SftpClient,
  type SftpDirEntry,
} from './sftp-client.js';
import type {
  ArtifactRegistryPort,
  RegisterArtifactInput,
  RetrievalEnginePort,
  StoredArtifact,
} from './ports.js';
import type { SftpRootConfig } from './config.js';

export const SFTP_INDEXER_COMPONENT = 'sftp-indexer';
/** Authority level for artifacts observed on deployed servers (§30: deployed config). */
export const SFTP_INDEXER_AUTHORITY = 'deployed_config';

export interface SftpIndexerDeps {
  /** Raw SFTP client; the indexer wraps it in a deny guard per root. */
  client: SftpClient;
  registry: ArtifactRegistryPort;
  retrieval: RetrievalEnginePort;
}

export interface SftpIndexerOptions {
  maxFileBytes?: number;
  maxDepth?: number;
  /**
   * Extra deny rules per root, keyed by `${serverId}:${rootPath}`
   * (from compileConfig). The unconditional hard deny set always applies.
   */
  extraDenyByRoot?: ReadonlyMap<string, readonly DenyRule[]>;
  /** Clock for observedTime; defaults to real time. */
  now?: () => string;
}

export interface ScanCounters {
  scanned: number;
  skippedUnchanged: number;
  skippedDenied: number;
  skippedFiltered: number;
  skippedBinary: number;
  skippedSecretContent: number;
  skippedOversized: number;
  skippedEmpty: number;
  indexedCreated: number;
  indexedSuperseded: number;
  invalidated: number;
  errors: string[];
}

export type ScanResult = ScanCounters & {
  serverId: string;
  startedAt: string;
  finishedAt: string;
};

function zeroCounters(): ScanCounters {
  return {
    scanned: 0,
    skippedUnchanged: 0,
    skippedDenied: 0,
    skippedFiltered: 0,
    skippedBinary: 0,
    skippedSecretContent: 0,
    skippedOversized: 0,
    skippedEmpty: 0,
    indexedCreated: 0,
    indexedSuperseded: 0,
    invalidated: 0,
    errors: [],
  };
}

export function buildSftpLocator(serverId: string, absolutePath: string): string {
  const normalized = absolutePath.startsWith('/') ? absolutePath : `/${absolutePath}`;
  return `sftp:${serverId}:${normalized}`;
}

export class SftpIndexer {
  private readonly serverId: string;
  private readonly roots: readonly SftpRootConfig[];
  private readonly deps: SftpIndexerDeps;
  private readonly maxFileBytes: number;
  private readonly maxDepth: number;
  private readonly extraDenyByRoot: ReadonlyMap<string, readonly DenyRule[]>;
  private readonly now: () => string;

  constructor(
    serverId: string,
    roots: readonly SftpRootConfig[],
    deps: SftpIndexerDeps,
    options: SftpIndexerOptions = {},
  ) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(serverId)) {
      throw new Error(`invalid serverId "${serverId}"`);
    }
    this.serverId = serverId;
    this.roots = roots;
    this.deps = deps;
    this.maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024;
    this.maxDepth = options.maxDepth ?? 12;
    this.extraDenyByRoot = options.extraDenyByRoot ?? new Map();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ------------------------------------------------------------------ scan

  /** Full incremental scan of every allowlisted root. */
  async scan(): Promise<ScanResult> {
    const startedAt = this.now();
    const counters = zeroCounters();
    const seen = new Set<string>();

    for (const root of this.roots) {
      const extra = this.extraDenyByRoot.get(`${this.serverId}:${root.path}`) ?? [];
      try {
        // Canonical root resolution happens once per root. Every later
        // operation re-checks lexical + realpath containment.
        assertAllowedPath(root.path, extra);
        const guarded = await DenyGuardSftpClient.forRoot(this.deps.client, root.path, extra);
        await this.walk(guarded, extra, root, root.path, 0, seen, counters);
      } catch (err) {
        if (err instanceof SecretDenyError) {
          counters.skippedDenied += 1;
          counters.errors.push(`root denied: ${err.message}`);
        } else {
          counters.errors.push(`root ${root.path}: ${(err as Error).message}`);
        }
      }
    }

    if (counters.errors.length > 0) {
      await this.markCurrentStale(counters);
    } else {
      await this.invalidateDeleted(seen, counters);
    }

    return { serverId: this.serverId, startedAt, finishedAt: this.now(), ...counters };
  }

  // ------------------------------------------------------------------ walk

  private async walk(
    client: SftpClient,
    extra: readonly DenyRule[],
    root: SftpRootConfig,
    dirPath: string,
    depth: number,
    seen: Set<string>,
    counters: ScanCounters,
  ): Promise<void> {
    let entries: SftpDirEntry[];
    try {
      entries = await client.listDir(dirPath);
    } catch (err) {
      if (err instanceof SecretDenyError) {
        counters.skippedDenied += 1;
        return;
      }
      counters.errors.push(`list ${dirPath}: ${(err as Error).message}`);
      return;
    }
    for (const entry of entries) {
      const entryPath = posixPath.normalize(entry.path.replace(/\\/g, '/'));
      const relative = posixPath.relative(posixPath.normalize(root.path), entryPath);
      if (relative === '..' || relative.startsWith('../') || posixPath.isAbsolute(relative)) {
        counters.errors.push(`path escaped root: ${entryPath}`);
        continue;
      }
      // Belt and suspenders: filter before stat even though the guarded
      // client would also refuse. Denied entries are never descended into.
      if (isDeniedPath(entryPath, extra)) {
        counters.skippedDenied += 1;
        continue;
      }
      if (entry.isDirectory) {
        if (depth < this.maxDepth) {
          await this.walk(client, extra, root, entryPath, depth + 1, seen, counters);
        }
        continue;
      }
      counters.scanned += 1;
      // Mark present BEFORE processing: a file that exists on disk is never
      // "deleted", even if it is skipped (unchanged, filtered, binary,
      // oversized, ...). invalidateDeleted only touches files the walk did
      // not list at all.
      seen.add(buildSftpLocator(this.serverId, entryPath));
      await this.processFile(client, extra, root, entryPath, counters);
    }
  }

  // ------------------------------------------------------------------ file

  private async processFile(
    client: SftpClient,
    extra: readonly DenyRule[],
    root: SftpRootConfig,
    filePath: string,
    counters: ScanCounters,
  ): Promise<void> {
    const locator = buildSftpLocator(this.serverId, filePath);
    try {
      const current = this.deps.registry.getCurrent(locator);
      // Extension allowlist (when configured) is checked before any read.
      if (root.includeExtensions !== undefined && root.includeExtensions.length > 0) {
        const ext = posixPath.extname(filePath).toLowerCase();
        if (!root.includeExtensions.map((e) => e.toLowerCase()).includes(ext)) {
          counters.skippedFiltered += 1;
          if (current !== undefined) {
            this.deps.registry.markInvalid(current.artifactId);
            await this.deps.retrieval.updateArtifactStatus(current.artifactId, SourceStatus.INVALID);
            counters.invalidated += 1;
          }
          return;
        }
      }

      const stat = await client.stat(filePath);
      if (stat.isDirectory) return;
      if (stat.size > this.maxFileBytes) {
        counters.skippedOversized += 1;
        if (current !== undefined) await this.markArtifactStale(current, counters);
        return;
      }

      // Correctness-first fingerprint: always hash. Size+mtime alone can be
      // preserved across an edit and therefore cannot prove freshness.
      const sha256 = await client.hashFile(filePath, this.maxFileBytes);
      const version = fingerprintToVersion({ sha256, size: stat.size, mtimeMs: stat.mtimeMs });
      if (current !== undefined && current.version === version) {
        if (current.status === SourceStatus.STALE) {
          const refreshed = this.deps.registry.revalidate(current.artifactId, this.now());
          await this.deps.retrieval.updateArtifactStatus(refreshed.artifactId, SourceStatus.CURRENT);
        }
        counters.skippedUnchanged += 1;
        return;
      }

      const content = await client.readFile(filePath, this.maxFileBytes);
      const prepared: PrepareOutcome = prepareDocumentText(content, this.maxFileBytes, filePath);
      if (!prepared.ok) {
        switch (prepared.skippedReason) {
          case 'binary': counters.skippedBinary += 1; break;
          case 'secret-content': counters.skippedSecretContent += 1; break;
          case 'oversized': counters.skippedOversized += 1; break;
          default: counters.skippedEmpty += 1; break;
        }
        if (current !== undefined) await this.markArtifactStale(current, counters);
        return;
      }

      const input: RegisterArtifactInput = {
        sourceType: SourceType.SFTP_FILE,
        sourceLocator: locator,
        component: SFTP_INDEXER_COMPONENT,
        authority: `${SFTP_INDEXER_AUTHORITY}:${this.serverId}`,
        version,
        observedTime: this.now(),
        visibility: root.visibility as Visibility,
        contentMetadata: {
          contentType: 'text/plain',
          title: posixPath.basename(filePath),
          sizeBytes: stat.size,
          extra: {
            mtimeMs: stat.mtimeMs,
            serverId: this.serverId,
            remotePath: filePath,
            redactedFields: prepared.redactedFields,
            redactionCount: prepared.redactionCount,
          },
        },
        parserVersion: PARSER_VERSION,
      };
      const result = this.deps.registry.register(input);

      if (result.outcome === 'UNCHANGED') {
        counters.skippedUnchanged += 1;
        return;
      }
      const artifact: StoredArtifact = result.artifact;
      const sourceArtifact: SourceArtifact = { ...artifact };
      if (result.outcome === 'SUPERSEDED' && result.supersededArtifactId !== undefined) {
        // Old chunks leave current retrieval (§13.3); history stays in W04.
        await this.deps.retrieval.updateArtifactStatus(result.supersededArtifactId, SourceStatus.SUPERSEDED);
        counters.indexedSuperseded += 1;
      } else {
        counters.indexedCreated += 1;
      }
      await this.deps.retrieval.indexArtifactText(sourceArtifact, SourceStatus.CURRENT, prepared.text);
    } catch (err) {
      if (err instanceof SecretDenyError) {
        counters.skippedDenied += 1;
        counters.errors.push(`DENY-FIRED-IN-PROCESS (bug): ${err.message}`);
      } else if (err instanceof SftpPathEscapeError) {
        counters.errors.push(`path confinement blocked: ${err.remotePath}`);
      } else {
        counters.errors.push(`${locator}: ${(err as Error).message}`);
      }
    }
  }

  private async markArtifactStale(
    artifact: StoredArtifact,
    counters: ScanCounters,
  ): Promise<void> {
    try {
      this.deps.registry.markStale(artifact.artifactId);
      await this.deps.retrieval.updateArtifactStatus(artifact.artifactId, SourceStatus.STALE);
    } catch (err) {
      counters.errors.push(`stale ${artifact.sourceLocator}: ${(err as Error).message}`);
    }
  }

  private async markCurrentStale(counters: ScanCounters): Promise<void> {
    const prefix = `sftp:${this.serverId}:`;
    const current = this.deps.registry.listCurrent({
      sourceType: SourceType.SFTP_FILE,
      component: SFTP_INDEXER_COMPONENT,
    });
    for (const artifact of current) {
      if (artifact.sourceLocator.startsWith(prefix)) {
        await this.markArtifactStale(artifact, counters);
      }
    }
  }

  // ------------------------------------------------------------------ deletion

  /**
   * Files present in the registry but absent from the server are marked
   * INVALID: removed from current retrieval, preserved as history (§13.4).
   */
  private async invalidateDeleted(seen: Set<string>, counters: ScanCounters): Promise<void> {
    const prefix = `sftp:${this.serverId}:`;
    let known: StoredArtifact[];
    try {
      known = this.deps.registry.listCurrent({
        sourceType: SourceType.SFTP_FILE,
        component: SFTP_INDEXER_COMPONENT,
      });
    } catch (err) {
      counters.errors.push(`listCurrent failed: ${(err as Error).message}`);
      return;
    }
    for (const artifact of known) {
      if (!artifact.sourceLocator.startsWith(prefix)) continue;
      if (seen.has(artifact.sourceLocator)) continue;
      try {
        this.deps.registry.markInvalid(artifact.artifactId);
        await this.deps.retrieval.updateArtifactStatus(artifact.artifactId, SourceStatus.INVALID);
        counters.invalidated += 1;
      } catch (err) {
        counters.errors.push(`invalidate ${artifact.sourceLocator}: ${(err as Error).message}`);
      }
    }
  }
}
