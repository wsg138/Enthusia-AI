import { createHash } from 'node:crypto';
import type {
  ActionRequestResult,
  TicketBotClient,
} from '@enthusia/integration-ticket-bot';
import type {
  TicketEvidenceReviewResult,
  TicketImageAssessmentRecord,
} from './types.js';

export interface TicketEscalationRequester {
  requestAction(
    ticketId: string,
    input: {
      action: 'escalate';
      reason: string;
      correlationId: string;
      parameters: {
        extra: Record<string, unknown>;
      };
    },
  ): Promise<ActionRequestResult>;
}

export interface DeliverTicketEvidenceReviewInput {
  ticketId: string;
  review: TicketEvidenceReviewResult;
  imageEvidence: TicketImageAssessmentRecord[];
  ticketClient: TicketEscalationRequester | TicketBotClient;
}

export async function deliverTicketEvidenceReview(
  input: DeliverTicketEvidenceReviewInput,
): Promise<ActionRequestResult | null> {
  if (!input.review.shouldEscalate) return null;
  const correlationId = evidenceReviewCorrelationId(
    input.ticketId,
    input.imageEvidence,
  );
  return input.ticketClient.requestAction(input.ticketId, {
    action: 'escalate',
    reason: input.review.summary,
    correlationId,
    parameters: {
      extra: {
        source: 'ticket-evidence-review',
        disposition: input.review.disposition,
        confidence: input.review.confidence,
        evidenceRefs: input.imageEvidence.map((item) => item.evidenceRef),
      },
    },
  });
}

export function evidenceReviewCorrelationId(
  ticketId: string,
  imageEvidence: TicketImageAssessmentRecord[],
): string {
  const digest = createHash('sha256');
  digest.update(ticketId);
  for (const item of [...imageEvidence].sort(compareEvidence)) {
    digest.update('\0');
    digest.update(item.evidenceRef);
    digest.update('\0');
    digest.update(item.evidenceSha256);
  }
  return `evidence-review:${ticketId}:${digest.digest('hex').slice(0, 32)}`;
}

function compareEvidence(
  left: TicketImageAssessmentRecord,
  right: TicketImageAssessmentRecord,
): number {
  return left.evidenceRef.localeCompare(right.evidenceRef);
}
