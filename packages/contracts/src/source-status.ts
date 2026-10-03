/**
 * Source lifecycle status.
 *
 * Spec: WORKER-EXECUTION-PLAN.md §4 (W01 "Must define") and
 * MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §4 (revision states).
 */
export enum SourceStatus {
  /** Best-supported current value / artifact. */
  CURRENT = 'CURRENT',
  /** Was current but has a known replacement; never returned as current. */
  SUPERSEDED = 'SUPERSEDED',
  /** No longer supported and has no accepted replacement. */
  INVALID = 'INVALID',
  /** Authoritative evidence disagrees; no precedence rule resolves it safely. */
  CONFLICTED = 'CONFLICTED',
  /** Source/version can no longer be proven current; do not use as verified fact. */
  STALE = 'STALE',
}

/** Revision states usable as a memory revision's status (§49 + verification spec §4). */
export const MEMORY_REVISION_STATUSES = [
  SourceStatus.CURRENT,
  SourceStatus.SUPERSEDED,
  SourceStatus.INVALID,
  SourceStatus.CONFLICTED,
  SourceStatus.STALE,
] as const;

export type MemoryRevisionStatus = (typeof MEMORY_REVISION_STATUSES)[number];
