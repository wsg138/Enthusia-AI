import type {
  ActionRequestResult,
  TicketBotClient,
  TicketContextBundle,
  TicketEvidenceClient,
} from '@enthusia/integration-ticket-bot';
import type { LocalPolicyConcernAssessor } from './policy-assessor.js';
import type {
  PolicyConcernAssessmentResult,
} from './policy-assessor.js';
import type { VerifiedPolicyCatalog } from './policy-catalog.js';
import {
  collectTicketImageAssessments,
  type TicketImageAssessmentRunner,
  type TicketImageCollectionResult,
} from './orchestrator.js';
import { reviewTicketEvidence } from './review.js';
import { deliverTicketEvidenceReview } from './delivery.js';
import type {
  AuthoritativeModerationState,
  TicketEvidenceReviewResult,
} from './types.js';

export type TicketEvidencePipelineStatus =
  | 'needs_target'
  | 'already_actioned'
  | 'needs_more_evidence'
  | 'no_escalation'
  | 'policy_assessment_unavailable'
  | 'moderation_state_unavailable'
  | 'staff_escalation_submitted'
  | 'staff_escalation_failed';

export interface TicketEvidencePipelineInput {
  ticket: TicketContextBundle;
  traceId: string;
  evidenceClient: Pick<TicketEvidenceClient, 'getImageEvidence'>;
  policyCatalog: VerifiedPolicyCatalog;
  policyAssessor: Pick<LocalPolicyConcernAssessor, 'assess'>;
  moderationState: AuthoritativeModerationState;
  ticketClient: Pick<TicketBotClient, 'requestAction'>;
  maxImages?: number;
  assessImage?: TicketImageAssessmentRunner;
}

export interface TicketEvidencePipelineResult {
  status: TicketEvidencePipelineStatus;
  collection: TicketImageCollectionResult;
  policyAssessment: PolicyConcernAssessmentResult | null;
  review: TicketEvidenceReviewResult | null;
  delivery: ActionRequestResult | null;
}

const EMPTY_COLLECTION: TicketImageCollectionResult = {
  assessments: [],
  issues: [],
  eligibleAttachmentCount: 0,
  attemptedCount: 0,
};

export async function runTicketEvidencePipeline(
  input: TicketEvidencePipelineInput,
): Promise<TicketEvidencePipelineResult> {
  const preflight = preflightReview(input);
  const preflightResult = earlyResult(preflight);
  if (preflightResult !== null) return preflightResult;

  const collection = await collectImages(input);
  if (collection.assessments.length === 0) {
    return noUsableEvidenceResult(input, collection);
  }

  const policyAssessment = await assessPolicy(input, collection);
  if (policyAssessment === null) {
    return {
      status: 'policy_assessment_unavailable',
      collection,
      policyAssessment: null,
      review: null,
      delivery: null,
    };
  }

  const review = reviewTicketEvidence({
    ticket: input.ticket,
    imageEvidence: collection.assessments,
    concerns: policyAssessment.concerns,
    policyNeedsMoreContext: policyAssessment.needsMoreContext,
    moderationState: input.moderationState,
  });
  return finishReview(input, collection, policyAssessment, review);
}

function preflightReview(
  input: TicketEvidencePipelineInput,
): TicketEvidenceReviewResult {
  return reviewTicketEvidence({
    ticket: input.ticket,
    imageEvidence: [],
    concerns: [],
    moderationState: input.moderationState,
  });
}

function earlyResult(
  review: TicketEvidenceReviewResult,
): TicketEvidencePipelineResult | null {
  if (review.target === null) {
    return completedWithoutWork('needs_target', review);
  }
  if (review.disposition === 'already_actioned') {
    return completedWithoutWork('already_actioned', review);
  }
  return null;
}

function completedWithoutWork(
  status: 'needs_target' | 'already_actioned',
  review: TicketEvidenceReviewResult,
): TicketEvidencePipelineResult {
  return {
    status,
    collection: { ...EMPTY_COLLECTION },
    policyAssessment: null,
    review,
    delivery: null,
  };
}

function collectImages(
  input: TicketEvidencePipelineInput,
): Promise<TicketImageCollectionResult> {
  return collectTicketImageAssessments({
    ticket: input.ticket,
    evidenceClient: input.evidenceClient,
    traceId: input.traceId,
    ...(input.maxImages !== undefined ? { maxImages: input.maxImages } : {}),
    ...(input.assessImage !== undefined
      ? { assessImage: input.assessImage }
      : {}),
  });
}

function noUsableEvidenceResult(
  input: TicketEvidencePipelineInput,
  collection: TicketImageCollectionResult,
): TicketEvidencePipelineResult {
  const review = reviewTicketEvidence({
    ticket: input.ticket,
    imageEvidence: [],
    concerns: [],
    moderationState: input.moderationState,
  });
  return {
    status: 'needs_more_evidence',
    collection,
    policyAssessment: null,
    review,
    delivery: null,
  };
}

async function assessPolicy(
  input: TicketEvidencePipelineInput,
  collection: TicketImageCollectionResult,
): Promise<PolicyConcernAssessmentResult | null> {
  const target = preflightReview(input).target;
  if (target === null) return null;
  try {
    return await input.policyAssessor.assess({
      traceId: input.traceId,
      target: target.value,
      catalog: input.policyCatalog,
      imageEvidence: collection.assessments,
    });
  } catch {
    return null;
  }
}

async function finishReview(
  input: TicketEvidencePipelineInput,
  collection: TicketImageCollectionResult,
  policyAssessment: PolicyConcernAssessmentResult,
  review: TicketEvidenceReviewResult,
): Promise<TicketEvidencePipelineResult> {
  if (!review.shouldEscalate) {
    return {
      status: nonEscalationStatus(review),
      collection,
      policyAssessment,
      review,
      delivery: null,
    };
  }

  if (input.moderationState.availability !== 'verified') {
    return {
      status: 'moderation_state_unavailable',
      collection,
      policyAssessment,
      review,
      delivery: null,
    };
  }

  return submitStaffEscalation(input, collection, policyAssessment, review);
}

function nonEscalationStatus(
  review: TicketEvidenceReviewResult,
): 'already_actioned' | 'needs_more_evidence' | 'no_escalation' {
  switch (review.disposition) {
    case 'already_actioned':
      return 'already_actioned';
    case 'needs_more_evidence':
      return 'needs_more_evidence';
    case 'no_escalation':
    case 'staff_review':
      return 'no_escalation';
  }
}

async function submitStaffEscalation(
  input: TicketEvidencePipelineInput,
  collection: TicketImageCollectionResult,
  policyAssessment: PolicyConcernAssessmentResult,
  review: TicketEvidenceReviewResult,
): Promise<TicketEvidencePipelineResult> {
  try {
    const delivery = await deliverTicketEvidenceReview({
      ticketId: input.ticket.ticket.id,
      review,
      imageEvidence: collection.assessments,
      ticketClient: input.ticketClient,
    });
    return {
      status: 'staff_escalation_submitted',
      collection,
      policyAssessment,
      review,
      delivery,
    };
  } catch {
    return {
      status: 'staff_escalation_failed',
      collection,
      policyAssessment,
      review,
      delivery: null,
    };
  }
}
