import type {
  StaffModerationStateSnapshot,
} from '@enthusia/integration-staff-moderation';
import type {
  AuthoritativeModerationState,
  EvidencePolicyConcern,
} from './types.js';

export function staffSnapshotToModerationState(
  snapshot: StaffModerationStateSnapshot,
  concerns: EvidencePolicyConcern[] = [],
): AuthoritativeModerationState {
  const target = snapshot.target.requested;
  const duplicateStatus = duplicateStatusFor(snapshot, concerns);
  return {
    availability: 'verified',
    target,
    duplicateStatus,
    activeSanctions: snapshot.activeSanctions.map((sanction) => ({
      id: sanction.sanctionId,
      type: sanction.type,
      status: 'ACTIVE',
      reason: sanction.publicReason,
    })),
    fetchedAt: snapshot.fetchedAt,
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

function duplicateStatusFor(
  snapshot: StaffModerationStateSnapshot,
  concerns: EvidencePolicyConcern[],
): AuthoritativeModerationState['duplicateStatus'] {
  const ruleIds = new Set(concerns.map((concern) => concern.code));
  if (ruleIds.size === 0) return 'none';

  let reviewOpen = false;
  for (const caseRecord of snapshot.recentCases) {
    if (!ruleIds.has(caseRecord.exactReasonId)) continue;
    if (caseRecord.state === 'FULLY_OVERTURNED') continue;
    if (
      caseRecord.hasActiveSanctions ||
      caseRecord.state === 'CLOSED'
    ) {
      return 'actioned';
    }
    if (caseRecord.state === 'OPEN') reviewOpen = true;
  }
  return reviewOpen ? 'review_open' : 'none';
}
