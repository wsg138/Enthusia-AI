import type { TicketBotClient } from './client.js';
import type { ActionRequestResult, ActionRequestStatus } from './types.js';

export type TicketActionVerification =
  | 'confirmed'
  | 'pending'
  | 'not-completed'
  | 'unverified';

export interface VerifiedTicketActionResult extends ActionRequestResult {
  /**
   * Whether Enthusia AI may truthfully tell a user that the requested
   * lifecycle action succeeded.
   */
  canReportSuccess: boolean;
  verification: TicketActionVerification;
}

export interface ActionRequestStatusReader {
  getActionRequest(requestId: string): Promise<ActionRequestResult>;
}

function verificationFor(status: ActionRequestStatus): TicketActionVerification {
  switch (status) {
    case 'accepted':
      return 'confirmed';
    case 'pending':
      return 'pending';
    case 'rejected':
    case 'superseded':
    case 'expired':
      return 'not-completed';
  }
}

function matchesSubmission(
  submitted: ActionRequestResult,
  persisted: ActionRequestResult,
): boolean {
  return (
    persisted.requestId === submitted.requestId &&
    persisted.ticketId === submitted.ticketId &&
    persisted.action === submitted.action
  );
}

function unverified(submitted: ActionRequestResult): VerifiedTicketActionResult {
  return {
    ...submitted,
    verification: 'unverified',
    canReportSuccess: false,
  };
}

/**
 * Re-read the Ticket Bot's persisted action request before allowing a success
 * claim. The Support Bot contract keeps ambiguous/partial execution pending;
 * therefore only a matching persisted "accepted" record is confirmation.
 *
 * Verification failure is intentionally represented as uncertainty rather
 * than as success or a thrown error: the POST may have changed state even if
 * the follow-up read failed.
 */
export async function verifyTicketActionRequest(
  reader: Pick<TicketBotClient, 'getActionRequest'> | ActionRequestStatusReader,
  submitted: ActionRequestResult,
): Promise<VerifiedTicketActionResult> {
  try {
    const persisted = await reader.getActionRequest(submitted.requestId);
    if (!matchesSubmission(submitted, persisted)) return unverified(submitted);
    const verification = verificationFor(persisted.status);
    return {
      ...persisted,
      verification,
      canReportSuccess: verification === 'confirmed',
    };
  } catch {
    return unverified(submitted);
  }
}
