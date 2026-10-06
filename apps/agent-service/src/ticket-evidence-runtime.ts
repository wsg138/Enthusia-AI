import type { InferenceClient } from '@enthusia/inference-adapter';
import type {
  TicketBotClient,
  TicketEvidenceClient,
} from '@enthusia/integration-ticket-bot';
import {
  activeTicketEscalation,
  ticketReportTarget,
} from '@enthusia/integration-ticket-bot';
import {
  StaffModerationStateClient,
} from '@enthusia/integration-staff-moderation';
import type { LiveServerSourceGateway } from '@enthusia/integration-sftp';
import {
  LocalPolicyConcernAssessor,
  loadCurrentPolicyCatalog,
  runTicketEvidencePipeline,
  staffSnapshotToModerationState,
  unavailableModerationState,
  type LivePolicyCatalogSource,
  type EvidencePolicyConcern,
  type TicketEvidencePipelineResult,
  type TicketEvidencePipelineStatus,
  type TicketImageAssessmentRunner,
} from '@enthusia/ticket-evidence-review';

export type TicketEvidenceRuntimeStatus =
  | TicketEvidencePipelineStatus
  | 'not_applicable'
  | 'ticket_context_unavailable'
  | 'policy_source_unavailable'
  | 'evidence_runtime_unavailable';

export interface TicketEvidenceRuntimeResult {
  status: TicketEvidenceRuntimeStatus;
  retryable: boolean;
  pipeline: TicketEvidencePipelineResult | null;
}

export interface TicketEvidenceReviewRuntimeDeps {
  ticketClient: Pick<TicketBotClient, 'getTicketContext' | 'requestAction'>;
  evidenceClient: Pick<TicketEvidenceClient, 'getImageEvidence'>;
  staffClient: Pick<StaffModerationStateClient, 'getState'>;
  policyGateway: Pick<LiveServerSourceGateway, 'readApprovedFile'>;
  policySource: LivePolicyCatalogSource;
  inference: Pick<InferenceClient, 'complete'>;
  assessImage?: TicketImageAssessmentRunner;
}

export class TicketEvidenceReviewRuntime {
  private readonly policyAssessor: LocalPolicyConcernAssessor;

  constructor(private readonly deps: TicketEvidenceReviewRuntimeDeps) {
    this.policyAssessor = new LocalPolicyConcernAssessor(deps.inference);
  }

  async review(
    ticketId: string,
    traceId: string,
  ): Promise<TicketEvidenceRuntimeResult> {
    const ticket = await this.ticketContext(ticketId);
    if (ticket === null) {
      return runtimeResult('ticket_context_unavailable', true);
    }
    if (ticket.ticket.category !== 'report') {
      return runtimeResult('not_applicable', false);
    }

    const target = ticketReportTarget(ticket.ticket);
    if (target === null) {
      return runtimeResult('needs_target', false);
    }
    if (activeTicketEscalation(ticket.ticket) !== null) {
      return runtimeResult('already_actioned', false);
    }

    const initialModeration = unavailableModerationState(target.value);

    let policyCatalog;
    try {
      policyCatalog = await loadCurrentPolicyCatalog(
        this.deps.policyGateway,
        this.deps.policySource,
      );
    } catch {
      return runtimeResult('policy_source_unavailable', true);
    }

    const pipeline = await runTicketEvidencePipeline({
      ticket,
      traceId,
      evidenceClient: this.deps.evidenceClient,
      policyCatalog,
      policyAssessor: this.policyAssessor,
      moderationState: initialModeration,
      resolveModerationState: (concerns) =>
        this.resolveModerationState(target.value, concerns),
      ticketClient: this.deps.ticketClient,
      ...(this.deps.assessImage !== undefined
        ? { assessImage: this.deps.assessImage }
        : {}),
    });

    if (evidenceInfrastructureFailed(pipeline)) {
      return {
        status: 'evidence_runtime_unavailable',
        retryable: true,
        pipeline,
      };
    }
    return {
      status: pipeline.status,
      retryable: retryablePipelineStatus(pipeline.status),
      pipeline,
    };
  }

  private async ticketContext(ticketId: string) {
    try {
      return await this.deps.ticketClient.getTicketContext(ticketId);
    } catch {
      return null;
    }
  }

  private async resolveModerationState(
    target: string,
    concerns: EvidencePolicyConcern[],
  ) {
    const snapshot = await this.deps.staffClient.getState(target);
    return staffSnapshotToModerationState(snapshot, concerns);
  }
}

function runtimeResult(
  status: TicketEvidenceRuntimeStatus,
  retryable: boolean,
): TicketEvidenceRuntimeResult {
  return { status, retryable, pipeline: null };
}

function retryablePipelineStatus(
  status: TicketEvidencePipelineStatus,
): boolean {
  return (
    status === 'policy_assessment_unavailable' ||
    status === 'moderation_state_unavailable' ||
    status === 'staff_escalation_failed'
  );
}

function evidenceInfrastructureFailed(
  result: TicketEvidencePipelineResult,
): boolean {
  if (
    result.status !== 'needs_more_evidence' ||
    result.collection.eligibleAttachmentCount === 0 ||
    result.collection.assessments.length > 0
  ) {
    return false;
  }
  return result.collection.issues.some(
    (issue) =>
      issue.reason === 'fetch_failed' ||
      issue.reason === 'assessment_failed',
  );
}
