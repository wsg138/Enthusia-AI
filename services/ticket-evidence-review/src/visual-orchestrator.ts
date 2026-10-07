import type {
  TicketContextBundle,
  TicketEvidenceClient,
} from '@enthusia/integration-ticket-bot';
import {
  collectTicketImageAssessments,
  createDefaultTicketImageAssessmentRunner,
  type TicketImageAssessmentRunner,
  type TicketImageCollectionIssue,
} from './orchestrator.js';
import { MAX_POLICY_EVIDENCE_ITEMS } from './policy-assessor.js';
import {
  collectTicketVideoAssessments,
  type CollectTicketVideoAssessmentsInput,
  type TicketVideoCollectionIssue,
} from './video-orchestrator.js';
import type {
  TicketImageAssessmentRecord,
  TicketVideoAssessmentRecord,
} from './types.js';

export type TicketVisualAssessmentRecord =
  | TicketImageAssessmentRecord
  | TicketVideoAssessmentRecord;

export type TicketVisualCollectionIssue =
  | TicketImageCollectionIssue
  | TicketVideoCollectionIssue;

export interface TicketVisualCollectionResult {
  assessments: TicketVisualAssessmentRecord[];
  issues: TicketVisualCollectionIssue[];
  eligibleAttachmentCount: number;
  attemptedCount: number;
  imageAssessmentCount: number;
  videoAssessmentCount: number;
}

export type TicketVisualEvidenceClient =
  Pick<TicketEvidenceClient, 'getImageEvidence'> &
  Partial<Pick<TicketEvidenceClient, 'getVideoEvidence'>>;

export interface CollectTicketVisualAssessmentsInput {
  ticket: TicketContextBundle;
  evidenceClient: TicketVisualEvidenceClient;
  traceId: string;
  maxImages?: number;
  assessImage?: TicketImageAssessmentRunner;
  sampleVideo?: CollectTicketVideoAssessmentsInput['sampleVideo'];
}

export async function collectTicketVisualAssessments(
  input: CollectTicketVisualAssessmentsInput,
): Promise<TicketVisualCollectionResult> {
  const assessImage = sharedLazyAssessmentRunner(input.assessImage);
  const video = await collectVideos(input, assessImage);
  const remainingPolicySlots = Math.max(
    1,
    MAX_POLICY_EVIDENCE_ITEMS - video.assessments.length,
  );
  const requestedImages =
    input.maxImages === undefined
      ? remainingPolicySlots
      : Math.min(input.maxImages, remainingPolicySlots);

  const images = await collectTicketImageAssessments({
    ticket: withoutVideoAttachments(input.ticket),
    evidenceClient: input.evidenceClient,
    traceId: input.traceId,
    maxImages: requestedImages,
    assessImage,
  });

  return {
    assessments: [...video.assessments, ...images.assessments],
    issues: [...video.issues, ...images.issues],
    eligibleAttachmentCount:
      video.eligibleAttachmentCount + images.eligibleAttachmentCount,
    attemptedCount: video.attemptedCount + images.attemptedCount,
    imageAssessmentCount: images.assessments.length,
    videoAssessmentCount: video.assessments.length,
  };
}

async function collectVideos(
  input: CollectTicketVisualAssessmentsInput,
  assessImage: TicketImageAssessmentRunner,
) {
  const getVideoEvidence = input.evidenceClient.getVideoEvidence;
  if (getVideoEvidence === undefined) {
    return {
      assessments: [] as TicketVideoAssessmentRecord[],
      issues: [] as TicketVideoCollectionIssue[],
      eligibleAttachmentCount: 0,
      attemptedCount: 0,
    };
  }

  const evidenceClient = {
    getVideoEvidence: getVideoEvidence.bind(input.evidenceClient),
  };
  return collectTicketVideoAssessments({
    ticket: input.ticket,
    evidenceClient,
    traceId: input.traceId,
    assessImage,
    ...(input.sampleVideo !== undefined
      ? { sampleVideo: input.sampleVideo }
      : {}),
  });
}

function sharedLazyAssessmentRunner(
  injected: TicketImageAssessmentRunner | undefined,
): TicketImageAssessmentRunner {
  let runner = injected;
  return async (request) => {
    runner ??= createDefaultTicketImageAssessmentRunner();
    return runner(request);
  };
}

function withoutVideoAttachments(
  ticket: TicketContextBundle,
): TicketContextBundle {
  return {
    ...ticket,
    messages: ticket.messages.map((message) => ({
      ...message,
      ...(message.attachments === undefined
        ? {}
        : {
            attachments: message.attachments.filter(
              (attachment) =>
                !attachment.contentType
                  ?.trim()
                  .toLowerCase()
                  .startsWith('video/'),
            ),
          }),
    })),
  };
}
