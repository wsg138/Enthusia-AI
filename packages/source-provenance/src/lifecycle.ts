/**
 * @enthusia/source-provenance — artifact lifecycle state machine.
 *
 * Contract statuses: SourceStatus.CURRENT / SUPERSEDED / INVALID /
 * CONFLICTED / STALE.
 *
 * Spec: MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §4 (revision states),
 * MASTER-SPECIFICATION.md §12.2 (supersede affected old knowledge, preserve
 * history), §32 (correction loop: supersede old memory, record revision).
 *
 * Invariants enforced here and by the registry:
 * - exactly one CURRENT artifact per source locator at any time;
 * - SUPERSEDED is forever historical: it is never CURRENT again;
 * - INVALID is terminal: nothing transitions out of INVALID;
 * - a supersession is atomic (old -> SUPERSEDED and new -> CURRENT happen
 *   in one transaction; see registry).
 */

import { SourceStatus } from '@enthusia/contracts';

/** Events that drive artifact state transitions. */
export type LifecycleEvent =
  | 'SUPERSEDE' // a newer version of the same source was registered
  | 'INVALIDATE' // the source was deleted or is no longer trustworthy
  | 'MARK_STALE' // the version can no longer be proven current
  | 'REVALIDATE' // a STALE artifact was proven current again
  | 'REPORT_CONFLICT' // authoritative evidence disagrees, unresolved
  | 'RESOLVE_CONFLICT'; // a CONFLICTED artifact was resolved back to CURRENT

const TRANSITIONS: Record<SourceStatus, Partial<Record<LifecycleEvent, SourceStatus>>> = {
  [SourceStatus.CURRENT]: {
    SUPERSEDE: SourceStatus.SUPERSEDED,
    INVALIDATE: SourceStatus.INVALID,
    MARK_STALE: SourceStatus.STALE,
    REPORT_CONFLICT: SourceStatus.CONFLICTED,
  },
  [SourceStatus.STALE]: {
    REVALIDATE: SourceStatus.CURRENT,
    INVALIDATE: SourceStatus.INVALID,
  },
  [SourceStatus.CONFLICTED]: {
    RESOLVE_CONFLICT: SourceStatus.CURRENT,
    INVALIDATE: SourceStatus.INVALID,
  },
  // SUPERSEDED: historical forever. It may still be invalidated (e.g. the
  // old version is discovered to have been untrustworthy), but it can never
  // become CURRENT again — that would rewrite history.
  [SourceStatus.SUPERSEDED]: {
    INVALIDATE: SourceStatus.INVALID,
  },
  // INVALID is terminal.
  [SourceStatus.INVALID]: {},
};

/** All lifecycle events that are legal from `status`. */
export function allowedEvents(status: SourceStatus): LifecycleEvent[] {
  return Object.keys(TRANSITIONS[status] ?? {}) as LifecycleEvent[];
}

/**
 * Apply `event` to `status`, returning the next status. Throws when the
 * transition is illegal.
 */
export function transitionStatus(status: SourceStatus, event: LifecycleEvent): SourceStatus {
  const next = TRANSITIONS[status]?.[event];
  if (next === undefined) {
    throw new Error(`illegal lifecycle transition: ${status} + ${event}`);
  }
  return next;
}

/** True when this status counts as the trusted current view for a locator. */
export function isCurrentStatus(status: SourceStatus): boolean {
  return status === SourceStatus.CURRENT;
}

/**
 * True when an artifact with this status remains the latest indexed artifact
 * for its locator (the head of its history). STALE and CONFLICTED artifacts
 * are still the latest — they just must not be used as verified facts —
 * while SUPERSEDED and INVALID are never the head.
 */
export function isLatestStatus(status: SourceStatus): boolean {
  return (
    status === SourceStatus.CURRENT ||
    status === SourceStatus.STALE ||
    status === SourceStatus.CONFLICTED
  );
}
