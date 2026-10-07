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
  const vision = sharedVisionBudget(input.assessImage);
  const video = await collectVideos(input, vision.runner);
  const requestedImages = allowedImageCalls(
    input.maxImages,
    video.assessments.length,
    vision.remaining(),
  );
  const images = await collectTicketImageAssessments({
    ticket: withoutVideoAttachments(input.ticket),
    evidenceClient: input.evidenceClient,
    traceId: input.traceId,
    maxImages: requestedImages,
    assessImage: vision.runner,
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

interface SharedVisionBudget {
  runner: TicketImageAssessmentRunner;
  remaining(): number;
}

function sharedVisionBudget(
  injected: TicketImageAssessmentRunner | undefined,
): SharedVisionBudget {
  let runner = injected;
  let used = 0;
  return {
    remaining: () => Math.max(0, MAX_POLICY_EVIDENCE_ITEMS - used),
    runner: async (request) => {
      if (used >= MAX_POLICY_EVIDENCE_ITEMS) {
        throw new Error('ticket visual assessment budget exhausted');
      }
      used += 1;
      runner ??= createDefaultTicketImageAssessmentRunner();
      return runner(request);
    },
  };
}

function allowedImageCalls(
  requested: number | undefined,
  videoAssessments: number,
  remainingVisionCalls: number,
): number {
  const remainingPolicySlots = Math.max(
    0,
    MAX_POLICY_EVIDENCE_ITEMS - videoAssessments,
  );
  const requestedLimit = requested ?? remainingPolicySlots;
  return Math.max(
    0,
    Math.min(requestedLimit, remainingPolicySlots, remainingVisionCalls),
  );
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
