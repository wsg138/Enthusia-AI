import type {
  TicketAttachment,
  TicketContextBundle,
  TicketEvidenceClient,
} from '@enthusia/integration-ticket-bot';
import {
  CostTracker,
  MAX_VISION_IMAGE_BYTES,
  loadConfig,
  runImageEvidenceAssessment,
  type RunImageEvidenceInput,
  type RunImageEvidenceResult,
  type VisionImageContentType,
} from '@enthusia/openai-gateway';
import type { TicketImageAssessmentRecord } from './types.js';

export const MAX_TICKET_IMAGE_ASSESSMENTS = 3;
const MAX_COLLECTION_ISSUES = 16;

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
  evidenceClient: Pick<TicketEvidenceClient, 'getImageEvidence'>;
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
  let runner = input.assessImage;

  for (const candidate of selection.selected) {
    runner ??= createDefaultTicketImageAssessmentRunner();
    const outcome = await assessCandidate(input, candidate, runner);
    if ('record' in outcome) assessments.push(outcome.record);
    else issues.push(outcome.issue);
  }

  return {
    assessments,
    issues: issues.slice(0, MAX_COLLECTION_ISSUES),
    eligibleAttachmentCount: selection.eligibleCount,
    attemptedCount: selection.selected.length,
  };
}

export function createDefaultTicketImageAssessmentRunner(): TicketImageAssessmentRunner {
  const config = loadConfig();
  const tracker = new CostTracker(config.budget, config.modelPrices);
  return (request) =>
    runImageEvidenceAssessment(request, { config, tracker });
}

function boundedMaxImages(value: number | undefined): number {
  if (value === undefined) return MAX_TICKET_IMAGE_ASSESSMENTS;
  if (!Number.isInteger(value) || value <= 0) return 0;
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

  const selected = maxImages === 0 ? [] : candidates.slice(-maxImages);
  const omittedCount = candidates.length - selected.length;
  for (const omitted of candidates.slice(0, omittedCount)) {
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
  const evidence = await fetchEvidence(
    input.evidenceClient,
    input.ticket,
    candidate,
  );
  if (evidence === null) return candidateFailure(candidate, 'fetch_failed');

  const contentType = normalizedImageType(evidence.contentType);
  if (contentType === null) {
    return candidateFailure(candidate, 'unsupported_type');
  }

  try {
    const observed = await runner(
      assessmentRequest(input, candidate, evidence, contentType),
    );
    return {
      record: assessmentRecord(candidate, observed),
    };
  } catch {
    return candidateFailure(candidate, 'assessment_failed');
  }
}

function assessmentRequest(
  input: CollectTicketImageAssessmentsInput,
  candidate: ImageCandidate,
  evidence: Awaited<
    ReturnType<Pick<TicketEvidenceClient, 'getImageEvidence'>['getImageEvidence']>
  >,
  contentType: VisionImageContentType,
): RunImageEvidenceInput {
  return {
    traceId: input.traceId,
    evidenceRef: evidenceReference(
      input.ticket.ticket.id,
      candidate.messageId,
      candidate.attachment.id,
    ),
    image: {
      bytes: evidence.bytes,
      contentType,
      sha256: evidence.sha256,
    },
    context: {
      ticketCategory: input.ticket.ticket.category,
      userQuestion: input.ticket.ticket.subject,
    },
  };
}

function assessmentRecord(
  candidate: ImageCandidate,
  observed: RunImageEvidenceResult,
): TicketImageAssessmentRecord {
  return {
    messageId: candidate.messageId,
    attachmentId: candidate.attachment.id,
    evidenceRef: observed.evidenceRef,
    evidenceSha256: observed.evidenceSha256,
    assessment: observed.assessment,
  };
}

function candidateFailure(
  candidate: ImageCandidate,
  reason: TicketImageCollectionIssueReason,
): { issue: TicketImageCollectionIssue } {
  return {
    issue: issue(candidate.messageId, candidate.attachment.id, reason),
  };
}

async function fetchEvidence(
  client: Pick<TicketEvidenceClient, 'getImageEvidence'>,
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
