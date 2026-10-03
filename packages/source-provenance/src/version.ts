/**
 * @enthusia/source-provenance — version and hash semantics.
 *
 * Spec: MASTER-SPECIFICATION.md §54 (freshness semantics) and §12.2
 * (incremental indexing / fingerprints).
 *
 * Rules:
 * - A version is an opaque string observed at indexing time (Git SHA, blob
 *   SHA, file/content hash, config checksum, document version, DB
 *   revision/update timestamp, deployment version, ticket revision).
 * - An artifact is "valid while its version matches" the live source's
 *   version. Any difference in normalized version constitutes a change;
 *   the registry does not rank versions, it only detects change.
 * - Equality is decided on a normalized form so that equivalent
 *   representations of the same fingerprint (e.g. upper/lower-case hex)
 *   do not produce phantom supersessions.
 */

import { createHash } from 'node:crypto';

/** How two versions relate, for registry purposes. */
export type VersionComparison = 'SAME' | 'DIFFERENT';

/** Best-effort classification of a version string's shape. */
export type VersionKind = 'git-sha' | 'sha256' | 'semver' | 'timestamp' | 'opaque';

/**
 * Classify a version string. Used for diagnostics only — comparisons are
 * always done on the normalized form, never on kind.
 */
export function versionKind(version: string): VersionKind {
  const v = version.trim();
  if (/^[0-9a-fA-F]{40}$/.test(v)) return 'git-sha';
  if (/^[0-9a-fA-F]{64}$/.test(v)) return 'sha256';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return 'timestamp';
  if (/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(v)) return 'semver';
  return 'opaque';
}

/**
 * Normalize a version for equality comparison.
 *
 * - trims surrounding whitespace;
 * - lower-cases pure-hex fingerprints (Git SHAs, SHA-256 digests are
 *   case-insensitive encodings of the same bytes).
 *
 * Anything else is compared verbatim after trimming: a DB revision or a
 * ticket revision is only "same" when it is byte-identical.
 */
export function normalizeVersion(version: string): string {
  const v = version.trim();
  if (/^[0-9a-fA-F]+$/.test(v)) return v.toLowerCase();
  return v;
}

/**
 * Compare two versions: SAME when their normalized forms are equal,
 * DIFFERENT otherwise. Any difference is a change — the registry supersedes
 * the old artifact and registers the new one (§54).
 */
export function compareVersions(a: string, b: string): VersionComparison {
  return normalizeVersion(a) === normalizeVersion(b) ? 'SAME' : 'DIFFERENT';
}

/** True when `next` constitutes a change relative to `current`. */
export function isVersionChanged(current: string, next: string): boolean {
  return compareVersions(current, next) === 'DIFFERENT';
}

/**
 * Compute the canonical content fingerprint for byte-addressable sources
 * (SFTP files, configs, documents): SHA-256 over the raw bytes, hex-encoded.
 * Per §12.2: "file hash", "config checksum".
 */
export function computeContentHash(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Version descriptor used when registering an artifact: carries the raw
 * version string plus its kind for diagnostics/logging.
 */
export interface SourceVersion {
  /** Raw version string as observed from the source. */
  value: string;
  /** Shape classification (diagnostic only). */
  kind: VersionKind;
}

export function describeVersion(value: string): SourceVersion {
  return { value, kind: versionKind(value) };
}
