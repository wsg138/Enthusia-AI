import type {
  TicketAttachment,
  TicketContextBundle,
  TicketEvidenceClient,
} from '@enthusia/integration-ticket-bot';
import {
  MAX_VISION_IMAGE_BYTES,
  runImageEvidenceAssessment,
  type RunImageEvidenceInput,
  type RunImageEvidenceResult,
  type VisionImageContentType,
} from '@enthusia/openai-gateway';
import type { TicketImageAssessmentRecord } from './types.js';

export const MAX_TICKET_IMAGE_ASSESSMENTS = 4;

const SUPPORTED_IMAGE_TYPES = new Set<VisionImageContentType>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export type TicketImageCollectionIssueReason =
  | 'unsupported_type'
  | 'declared_too_large'
  | 'fetch_failed'
  | 'assessment_failed'
  | 'limit_exceeded';

export interface TicketImageCollectionIssue {
  messageId: string;
  attachmentId: string;
  reason: TicketImageCollectionIssueReason;
}

export interface TicketImageCollectionResult {
  assessments: TicketImageAssessmentRecord[];
  issues: TicketImageCollectionIssue[];
  eligibleAttachmentCount: number;
  attemptedCount: number;
}

export interface TicketImageAssessmentRunner {
  (input: RunImageEvidenceInput): Promise<RunImageEvidenceResult>;
}

export interface CollectTicketImageAssessmentsInput {
  ticket: TicketContextBundle;
  evidenceClient: TicketEvidenceClient;
  traceId: string;
  maxImages?: number;
  assessImage?: TicketImageAssessmentRunner;
}

interface ImageCandidate {
  messageId: string;
  attachment: TicketAttachment;
  contentType: VisionImageContentType;
}

export async function collectTicketImageAssessments(
  input: CollectTicketImageAssessmentsInput,
): Promise<TicketImageCollectionResult> {
  const maxImages = boundedMaxImages(input.maxImages);
  const selection = selectImageCandidates(input.ticket, maxImages);
  const assessments: TicketImageAssessmentRecord[] = [];
  const issues = [...selection.issues];
  const runner = input.assessImage ?? runImageEvidenceAssessment;

  for (const candidate of selection.selected) {
    const outcome = await assessCandidate(input, candidate, runner);
    if ('record' in outcome) assessments.push(outcome.record);
    else issues.push(outcome.issue);
  }

  return {
    assessments,
    issues,
    eligibleAttachmentCount: selection.eligibleCount,
    attemptedCount: selection.selected.length,
  };
}

function boundedMaxImages(value: number | undefined): number {
  if (value === undefined) return MAX_TICKET_IMAGE_ASSESSMENTS;
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_TICKET_IMAGE_ASSESSMENTS);
}

function selectImageCandidates(
  ticket: TicketContextBundle,
  maxImages: number,
): {
  selected: ImageCandidate[];
  issues: TicketImageCollectionIssue[];
  eligibleCount: number;
} {
  const candidates: ImageCandidate[] = [];
  const issues: TicketImageCollectionIssue[] = [];

  for (const message of ticket.messages) {
    for (const attachment of message.attachments ?? []) {
      const candidate = imageCandidate(message.id, attachment);
      if ('candidate' in candidate) candidates.push(candidate.candidate);
      else issues.push(candidate.issue);
    }
  }

  const selected = candidates.slice(-maxImages);
  for (const omitted of candidates.slice(0, Math.max(0, candidates.length - maxImages))) {
    issues.push(issue(omitted.messageId, omitted.attachment.id, 'limit_exceeded'));
  }
  return {
    selected,
    issues,
    eligibleCount: candidates.length,
  };
}

function imageCandidate(
  messageId: string,
  attachment: TicketAttachment,
): { candidate: ImageCandidate } | { issue: TicketImageCollectionIssue } {
  const contentType = normalizedImageType(attachment.contentType);
  if (contentType === null) {
    return { issue: issue(messageId, attachment.id, 'unsupported_type') };
  }
  if (attachment.size > MAX_VISION_IMAGE_BYTES) {
    return { issue: issue(messageId, attachment.id, 'declared_too_large') };
  }
  return {
    candidate: {
      messageId,
      attachment,
      contentType,
    },
  };
}

async function assessCandidate(
  input: CollectTicketImageAssessmentsInput,
  candidate: ImageCandidate,
  runner: TicketImageAssessmentRunner,
): Promise<
  | { record: TicketImageAssessmentRecord }
  | { issue: TicketImageCollectionIssue }
> {
  const evidence = await fetchEvidence(input.evidenceClient, input.ticket, candidate);
  if (evidence === null) {
    return {
      issue: issue(
        candidate.messageId,
        candidate.attachment.id,
        'fetch_failed',
      ),
    };
  }

  const contentType = normalizedImageType(evidence.contentType);
  if (contentType === null) {
    return {
      issue: issue(
        candidate.messageId,
        candidate.attachment.id,
        'unsupported_type',
      ),
    };
  }

  const evidenceRef = evidenceReference(
    input.ticket.ticket.id,
    candidate.messageId,
    candidate.attachment.id,
  );
  try {
    const observed = await runner({
      traceId: input.traceId,
      evidenceRef,
      image: {
        bytes: evidence.bytes,
        contentType,
        sha256: evidence.sha256,
      },
      context: {
        ticketCategory: input.ticket.ticket.category,
        userQuestion: input.ticket.ticket.subject,
      },
    });
    return {
      record: {
        messageId: candidate.messageId,
        attachmentId: candidate.attachment.id,
        evidenceRef: observed.evidenceRef,
        evidenceSha256: observed.evidenceSha256,
        assessment: observed.assessment,
      },
    };
  } catch {
    return {
      issue: issue(
        candidate.messageId,
        candidate.attachment.id,
        'assessment_failed',
      ),
    };
  }
}

async function fetchEvidence(
  client: TicketEvidenceClient,
  ticket: TicketContextBundle,
  candidate: ImageCandidate,
) {
  try {
    return await client.getImageEvidence(
      ticket.ticket.id,
      candidate.messageId,
      candidate.attachment.id,
    );
  } catch {
    return null;
  }
}

function normalizedImageType(
  value: string | undefined,
): VisionImageContentType | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined) return null;
  return SUPPORTED_IMAGE_TYPES.has(normalized as VisionImageContentType)
    ? (normalized as VisionImageContentType)
    : null;
}

function evidenceReference(
  ticketId: string,
  messageId: string,
  attachmentId: string,
): string {
  return `ticket:${ticketId}:message:${messageId}:attachment:${attachmentId}`;
}

function issue(
  messageId: string,
  attachmentId: string,
  reason: TicketImageCollectionIssueReason,
): TicketImageCollectionIssue {
  return { messageId, attachmentId, reason };
}
