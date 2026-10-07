import { createHash } from 'node:crypto';
import type {
  ActionRequestResult,
  TicketBotClient,
} from '@enthusia/integration-ticket-bot';
import type {
  TicketEvidenceReviewResult,
  TicketImageAssessmentRecord,
  TicketVideoAssessmentRecord,
} from './types.js';

export interface DeliverTicketEvidenceReviewInput {
  ticketId: string;
  review: TicketEvidenceReviewResult;
  imageEvidence: TicketImageAssessmentRecord[];
  ticketClient: Pick<TicketBotClient, 'requestAction'>;
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
        evidenceProvenance: input.imageEvidence.map(evidenceAuditRecord),
      },
    },
  });
}

function evidenceAuditRecord(
  item: TicketImageAssessmentRecord,
): Record<string, unknown> {
  if (isVideoAssessment(item)) {
    return {
      kind: 'video',
      ref: item.evidenceRef,
      sha256: item.evidenceSha256,
      source: item.video.source,
      submitterId: item.video.submitterId,
      submitterKind: item.video.submitterKind,
      submittedAt: item.video.submittedAt,
      contentType: item.video.contentType,
      durationSeconds: item.video.durationSeconds,
      width: item.video.width,
      height: item.video.height,
      codec: item.video.codec,
      format: item.video.format,
      frames: item.video.frames.map((frame) => ({
        index: frame.index,
        timestampSeconds: frame.timestampSeconds,
        ref: frame.evidenceRef,
        sha256: frame.sha256,
      })),
    };
  }
  return {
    kind: 'image',
    ref: item.evidenceRef,
    sha256: item.evidenceSha256,
  };
}

function isVideoAssessment(
  item: TicketImageAssessmentRecord,
): item is TicketVideoAssessmentRecord {
  return (
    'mediaKind' in item &&
    item.mediaKind === 'video' &&
    'video' in item
  );
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
