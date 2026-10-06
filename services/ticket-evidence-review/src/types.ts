import type {
  TicketContextBundle,
  TicketReportTarget,
} from '@enthusia/integration-ticket-bot';
import type { ImageEvidenceAssessment } from '@enthusia/openai-gateway';

export type EvidenceReviewDisposition =
  | 'needs_more_evidence'
  | 'staff_review'
  | 'already_actioned'
  | 'no_escalation';

export type EvidenceConcernSeverity =
  | 'low'
  | 'medium'
  | 'high'
  | 'critical';

export interface TicketImageAssessmentRecord {
  messageId: string;
  attachmentId: string;
  evidenceRef: string;
  evidenceSha256: string;
  assessment: ImageEvidenceAssessment;
}

export interface EvidencePolicyConcern {
  /** Stable rule/policy identifier when available. */
  code: string;
  label: string;
  severity: EvidenceConcernSeverity;
  confidence: number;
  /**
   * Evidence refs from TicketImageAssessmentRecord. Concerns without a
   * provenance-linked evidence ref are never sufficient for staff review.
   */
  evidenceRefs: string[];
  summary: string;
}

export type DuplicateReviewStatus =
  | 'none'
  | 'review_open'
  | 'actioned';

export interface ActiveSanctionSummary {
  id: string;
  type: string;
  status: string;
  reason: string;
}

export interface AuthoritativeModerationState {
  availability: 'verified' | 'unavailable';
  /** Minecraft username actually queried by the authoritative reader. */
  target: string;
  /**
   * A narrow authoritative determination that the current report/evidence
   * already has an open review or completed action. Unrelated sanctions must
   * not set this field.
   */
  duplicateStatus: DuplicateReviewStatus;
  activeSanctions: ActiveSanctionSummary[];
  fetchedAt?: string;
}

export interface TicketEvidenceReviewInput {
  ticket: TicketContextBundle;
  imageEvidence: TicketImageAssessmentRecord[];
  concerns: EvidencePolicyConcern[];
  moderationState: AuthoritativeModerationState;
}

export interface TicketEvidenceReviewResult {
  disposition: EvidenceReviewDisposition;
  target: TicketReportTarget | null;
  confidence: number;
  summary: string;
  observedFacts: string[];
  concerns: EvidencePolicyConcern[];
  limitations: string[];
  missingEvidence: string[];
  moderationState: AuthoritativeModerationState;
  shouldEscalate: boolean;
}
