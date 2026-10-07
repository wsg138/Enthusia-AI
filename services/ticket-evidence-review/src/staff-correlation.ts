import type {
  StaffModerationStateSnapshot,
} from '@enthusia/integration-staff-moderation';
import type {
  AuthoritativeModerationState,
  EvidencePolicyConcern,
} from './types.js';

export interface StaffModerationCorrelationInput {
  snapshot: StaffModerationStateSnapshot;
  target: string;
  concerns: EvidencePolicyConcern[];
  /** Earliest case timestamp eligible to suppress this report. */
  incidentSince: string;
}

/**
 * Correlate current EnthusiaStaff state to this specific evidence review.
 *
 * Conservative by design:
 * - exact verified reason-id match is required;
 * - a case older than this ticket/report window never suppresses escalation;
 * - FULLY_OVERTURNED cases never suppress;
 * - unrelated sanctions remain context only.
 */
export function correlateStaffModerationState(
  input: StaffModerationCorrelationInput,
): AuthoritativeModerationState {
  requireTargetMatch(input.snapshot, input.target);
  const since = parseTimestamp(input.incidentSince, 'incidentSince');
  const reasonIds = new Set(input.concerns.map((concern) => concern.code));
  const matching = input.snapshot.recentCases.filter((caseItem) =>
    reasonIds.has(caseItem.exactReasonId) &&
    caseItem.state !== 'FULLY_OVERTURNED' &&
    parseTimestamp(caseItem.issuedAt, 'case issuedAt') >= since,
  );

  const duplicateStatus = matching.some(
    (caseItem) =>
      caseItem.hasActiveSanctions || caseItem.state === 'CLOSED',
  )
    ? 'actioned'
    : matching.some((caseItem) => caseItem.state === 'OPEN')
      ? 'review_open'
      : 'none';

  return {
    availability: 'verified',
    target: input.snapshot.target.requested,
    duplicateStatus,
    activeSanctions: input.snapshot.activeSanctions.map((sanction) => ({
      id: sanction.sanctionId,
      type: sanction.type,
      status: 'ACTIVE',
      reason: sanction.publicReason,
    })),
    fetchedAt: input.snapshot.fetchedAt,
  };
}

export function unavailableModerationState(
  target: string,
): AuthoritativeModerationState {
  return {
    availability: 'unavailable',
    target,
    duplicateStatus: 'none',
    activeSanctions: [],
  };
}

function requireTargetMatch(
  snapshot: StaffModerationStateSnapshot,
  target: string,
): void {
  if (
    snapshot.target.requested.toLowerCase() === target.toLowerCase()
  ) {
    return;
  }
  throw new Error(
    'EnthusiaStaff moderation snapshot does not match the ticket target.',
  );
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Invalid ${label} timestamp in moderation correlation.`);
}
