import { z } from 'zod';
import {
  TicketBotClient,
  TicketEvidenceClient,
  activeTicketEscalation,
  ticketReportTarget,
  type ActionRequestResult,
  type TicketContextBundle,
} from '@enthusia/integration-ticket-bot';
import {
  StaffModerationStateClient,
  type StaffModerationStateSnapshot,
} from '@enthusia/integration-staff-moderation';
import type { InferenceClient } from '@enthusia/inference-adapter';
import type { LiveServerSourceGateway } from '@enthusia/integration-sftp';
import {
  LocalPolicyConcernAssessor,
  correlateStaffModerationState,
  parseCurrentReasonPolicyCatalog,
  reviewTicketEvidence,
  runTicketEvidencePipeline,
  unavailableModerationState,
  type TicketEvidencePipelineResult,
  type TicketEvidencePipelineStatus,
  type TicketImageAssessmentRunner,
  type VerifiedPolicyCatalog,
} from '@enthusia/ticket-evidence-review';

const ticketIdSchema = z.string().trim().regex(/^[1-9][0-9]{0,19}$/);

export const ticketEvidenceReviewRequestSchema = z.strictObject({
  ticketId: ticketIdSchema,
});

export type TicketEvidenceReviewRequest = z.infer<
  typeof ticketEvidenceReviewRequestSchema
>;

export interface TicketEvidenceReviewResponse {
  ticketId: string;
  status: TicketEvidencePipelineStatus;
  disposition:
    | 'needs_more_evidence'
    | 'staff_review'
    | 'already_actioned'
    | 'no_escalation'
    | null;
  summary: string | null;
  missingEvidence: string[];
  evidence: {
    eligibleAttachmentCount: number;
    attemptedCount: number;
    assessedCount: number;
    issueCounts: Record<string, number>;
  };
  policy: {
    version: string;
    fileVersion: string;
    needsMoreContext: boolean;
  } | null;
  moderation: {
    verified: boolean;
    duplicateStatus: 'none' | 'review_open' | 'actioned';
  };
  delivery: {
    requestId: string;
    status: ActionRequestResult['status'];
  } | null;
}

export interface LivePolicyCatalogReaderConfig {
  gateway: Pick<LiveServerSourceGateway, 'readApprovedFile'>;
  serverId: string;
  sourceId: string;
}

export class LivePolicyCatalogReader {
  constructor(private readonly config: LivePolicyCatalogReaderConfig) {}

  async read(): Promise<VerifiedPolicyCatalog> {
    const result = await this.config.gateway.readApprovedFile(
      this.config.serverId,
      this.config.sourceId,
    );
    if (!result.ok) {
      throw new Error('CURRENT moderation policy source is unavailable.');
    }
    if (
      result.result.content === undefined ||
      result.result.redactionCount !== 0
    ) {
      throw new Error(
        'CURRENT moderation policy source could not be used safely.',
      );
    }

    return parseCurrentReasonPolicyCatalog(result.result.content, {
      sourceId: result.result.sourceId,
      fileVersion: 'sha256:' + result.result.provenance.file.sha256,
      observedAt: result.result.provenance.observedAt,
      sourceStatus: 'CURRENT',
    });
  }
}

export interface TicketEvidenceReviewServiceDeps {
  ticketClient: Pick<
    TicketBotClient,
    'getTicketContext' | 'requestAction'
  >;
  evidenceClient: Pick<TicketEvidenceClient, 'getImageEvidence'>;
  policyReader: Pick<LivePolicyCatalogReader, 'read'>;
  moderationClient: Pick<StaffModerationStateClient, 'getState'>;
  inference: Pick<InferenceClient, 'complete'>;
  assessImage?: TicketImageAssessmentRunner;
}

export class TicketEvidenceReviewService {
  private readonly policyAssessor: LocalPolicyConcernAssessor;

  constructor(private readonly deps: TicketEvidenceReviewServiceDeps) {
    this.policyAssessor = new LocalPolicyConcernAssessor(deps.inference);
  }

  async review(
    input: unknown,
    traceId: string,
  ): Promise<TicketEvidenceReviewResponse> {
    const request = ticketEvidenceReviewRequestSchema.parse(input);
    const ticket = await this.deps.ticketClient.getTicketContext(
      request.ticketId,
      { maxMessages: 50, includeParticipants: true },
    );

    const early = earlyReview(ticket);
    if (early !== null) {
      return responseFromEarlyReview(request.ticketId, early);
    }

    const target = ticketReportTarget(ticket.ticket);
    if (target === null) {
      return responseFromEarlyReview(
        request.ticketId,
        reviewTicketEvidence({
          ticket,
          imageEvidence: [],
          concerns: [],
          moderationState: unavailableModerationState(''),
        }),
      );
    }

    const moderationPromise = this.readModeration(target.value);
    const policyCatalog = await this.deps.policyReader.read();
    const moderationSnapshot = await moderationPromise;
    const initialModeration = unavailableModerationState(target.value);

    const result = await runTicketEvidencePipeline({
      ticket,
      traceId,
      evidenceClient: this.deps.evidenceClient,
      policyCatalog,
      policyAssessor: this.policyAssessor,
      moderationState: initialModeration,
      moderationStateResolver: async ({ target: resolvedTarget, concerns }) => {
        if (moderationSnapshot === null) {
          throw new Error('Authoritative moderation state is unavailable.');
        }
        return correlateStaffModerationState({
          snapshot: moderationSnapshot,
          target: resolvedTarget,
          concerns,
          incidentSince: ticket.ticket.createdAt,
        });
      },
      ticketClient: this.deps.ticketClient,
      ...(this.deps.assessImage !== undefined
        ? { assessImage: this.deps.assessImage }
        : {}),
    });

    return responseFromPipeline(request.ticketId, result);
  }

  private async readModeration(
    target: string,
  ): Promise<StaffModerationStateSnapshot | null> {
    try {
      return await this.deps.moderationClient.getState(target);
    } catch {
      return null;
    }
  }
}

function earlyReview(
  ticket: TicketContextBundle,
): ReturnType<typeof reviewTicketEvidence> | null {
  const target = ticketReportTarget(ticket.ticket);
  if (target !== null && activeTicketEscalation(ticket.ticket) === null) {
    return null;
  }
  return reviewTicketEvidence({
    ticket,
    imageEvidence: [],
    concerns: [],
    moderationState: unavailableModerationState(target?.value ?? ''),
  });
}

function responseFromEarlyReview(
  ticketId: string,
  review: ReturnType<typeof reviewTicketEvidence>,
): TicketEvidenceReviewResponse {
  const status: TicketEvidencePipelineStatus =
    review.disposition === 'already_actioned'
      ? 'already_actioned'
      : 'needs_target';
  return {
    ticketId,
    status,
    disposition: review.disposition,
    summary: review.summary,
    missingEvidence: [...review.missingEvidence],
    evidence: {
      eligibleAttachmentCount: 0,
      attemptedCount: 0,
      assessedCount: 0,
      issueCounts: {},
    },
    policy: null,
    moderation: {
      verified: false,
      duplicateStatus: review.moderationState.duplicateStatus,
    },
    delivery: null,
  };
}

function responseFromPipeline(
  ticketId: string,
  result: TicketEvidencePipelineResult,
): TicketEvidenceReviewResponse {
  return {
    ticketId,
    status: result.status,
    disposition: result.review?.disposition ?? null,
    summary: result.review?.summary ?? null,
    missingEvidence: result.review?.missingEvidence
      ? [...result.review.missingEvidence]
      : [],
    evidence: {
      eligibleAttachmentCount: result.collection.eligibleAttachmentCount,
      attemptedCount: result.collection.attemptedCount,
      assessedCount: result.collection.assessments.length,
      issueCounts: countIssues(result.collection.issues),
    },
    policy: result.policyAssessment === null
      ? null
      : {
          version: result.policyAssessment.policyVersion,
          fileVersion: result.policyAssessment.policyFileVersion,
          needsMoreContext: result.policyAssessment.needsMoreContext,
        },
    moderation: {
      verified: result.review?.moderationState.availability === 'verified',
      duplicateStatus:
        result.review?.moderationState.duplicateStatus ?? 'none',
    },
    delivery: result.delivery === null
      ? null
      : {
          requestId: result.delivery.requestId,
          status: result.delivery.status,
        },
  };
}

function countIssues(
  issues: Array<{ reason: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.reason] = (counts[issue.reason] ?? 0) + 1;
  }
  return counts;
}
