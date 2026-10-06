import {
  activeTicketEscalation,
  ticketReportTarget,
  type TicketAttachment,
  type TicketContextBundle,
} from '@enthusia/integration-ticket-bot';
import type {
  AuthoritativeModerationState,
  EvidencePolicyConcern,
  TicketEvidenceReviewInput,
  TicketEvidenceReviewResult,
  TicketImageAssessmentRecord,
} from './types.js';

const STAFF_REVIEW_CONFIDENCE = 0.75;
const MORE_EVIDENCE_CONFIDENCE = 0.60;
const DIRECT_OBSERVATION_CONFIDENCE = 0.70;
const MAX_FACTS = 8;
const MAX_LIMITATIONS = 6;
const MAX_MISSING = 6;
const MAX_SUMMARY_CHARS = 1200;

export class EvidenceReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceReviewValidationError';
  }
}

interface ReviewContext {
  input: TicketEvidenceReviewInput;
  target: ReturnType<typeof ticketReportTarget>;
  observedFacts: string[];
  limitations: string[];
  strongest: EvidencePolicyConcern | null;
  needsMoreContext: boolean;
  missingEvidence: string[];
}

export function reviewTicketEvidence(
  input: TicketEvidenceReviewInput,
): TicketEvidenceReviewResult {
  const context = buildReviewContext(input);
  return preliminaryDisposition(context) ?? concernDisposition(context);
}

function buildReviewContext(
  input: TicketEvidenceReviewInput,
): ReviewContext {
  const target = ticketReportTarget(input.ticket.ticket);
  validateModerationTarget(target?.value ?? null, input.moderationState);
  validateEvidenceProvenance(input.ticket, input.imageEvidence);
  validateConcerns(input.concerns, input.imageEvidence);

  const limitations = boundedUnique(
    input.imageEvidence.flatMap((item) => item.assessment.limitations),
    MAX_LIMITATIONS,
  );
  const strongest = strongestConcern(input.concerns);
  return {
    input,
    target,
    observedFacts: directObservedFacts(input.imageEvidence),
    limitations,
    strongest,
    needsMoreContext: input.imageEvidence.some(
      (item) => item.assessment.needsMoreContext,
    ),
    missingEvidence: missingEvidenceFor(
      input.imageEvidence,
      limitations,
      strongest,
    ),
  };
}

function preliminaryDisposition(
  context: ReviewContext,
): TicketEvidenceReviewResult | null {
  if (context.target === null) return missingTargetResult(context);
  if (context.input.imageEvidence.length === 0) {
    return missingVisualEvidenceResult(context);
  }
  if (activeTicketEscalation(context.input.ticket.ticket) !== null) {
    return ticketEscalationDuplicateResult(context);
  }
  if (isDuplicate(context.input.moderationState)) {
    return moderationDuplicateResult(context);
  }
  return null;
}

function missingTargetResult(
  context: ReviewContext,
): TicketEvidenceReviewResult {
  return result(context.input, null, {
    disposition: 'needs_more_evidence',
    confidence: 1,
    observedFacts: context.observedFacts,
    limitations: context.limitations,
    missingEvidence: ['A validated reported-player target is required.'],
    summary: 'The report does not expose a validated reported-player target.',
  });
}

function missingVisualEvidenceResult(
  context: ReviewContext,
): TicketEvidenceReviewResult {
  const target = context.target;
  if (target === null) return missingTargetResult(context);
  return result(context.input, target, {
    disposition: 'needs_more_evidence',
    confidence: 1,
    observedFacts: context.observedFacts,
    limitations: context.limitations,
    missingEvidence: ['Attach screenshot or video evidence tied to this ticket.'],
    summary: `No provenance-linked visual evidence is available for ${target.value}.`,
  });
}

function ticketEscalationDuplicateResult(
  context: ReviewContext,
): TicketEvidenceReviewResult {
  return result(context.input, context.target, {
    disposition: 'already_actioned',
    confidence: 1,
    observedFacts: context.observedFacts,
    limitations: context.limitations,
    missingEvidence: [],
    summary:
      'Ticket Bot already has a pending or accepted staff escalation for this ticket; do not create a duplicate staff escalation.',
  });
}

function moderationDuplicateResult(
  context: ReviewContext,
): TicketEvidenceReviewResult {
  const state = context.input.moderationState;
  const label =
    state.duplicateStatus === 'actioned'
      ? 'already has authoritative action recorded'
      : 'already has an authoritative staff review open';
  return result(context.input, context.target, {
    disposition: 'already_actioned',
    confidence: 1,
    observedFacts: context.observedFacts,
    limitations: context.limitations,
    missingEvidence: [],
    summary: `This report ${label}; do not create a duplicate staff escalation.`,
  });
}

function concernDisposition(
  context: ReviewContext,
): TicketEvidenceReviewResult {
  if (context.strongest === null) return noConcernDisposition(context);
  if (isStrongGroundedConcern(context)) return staffReviewResult(context);
  if (needsMoreEvidence(context)) return moreEvidenceResult(context);
  return weakConcernResult(context);
}

function noConcernDisposition(
  context: ReviewContext,
): TicketEvidenceReviewResult {
  if (context.needsMoreContext) {
    return result(context.input, context.target, {
      disposition: 'needs_more_evidence',
      confidence: 0.7,
      observedFacts: context.observedFacts,
      limitations: context.limitations,
      missingEvidence: context.missingEvidence,
      summary:
        'The submitted visual evidence is incomplete or ambiguous and does not yet support a policy concern.',
    });
  }
  return result(context.input, context.target, {
    disposition: 'no_escalation',
    confidence: 0.85,
    observedFacts: context.observedFacts,
    limitations: context.limitations,
    missingEvidence: [],
    summary:
      'The submitted visual evidence is readable, but no rule-aware concern is currently supported.',
  });
}

function isStrongGroundedConcern(context: ReviewContext): boolean {
  const strongest = context.strongest;
  if (strongest === null) return false;
  return (
    strongest.confidence >= STAFF_REVIEW_CONFIDENCE &&
    concernHasDirectObservation(strongest, context.input.imageEvidence) &&
    !context.needsMoreContext
  );
}

function needsMoreEvidence(context: ReviewContext): boolean {
  return (
    (context.strongest?.confidence ?? 0) >= MORE_EVIDENCE_CONFIDENCE ||
    context.needsMoreContext
  );
}

function staffReviewResult(
  context: ReviewContext,
): TicketEvidenceReviewResult {
  const strongest = context.strongest;
  const target = context.target;
  if (strongest === null || target === null) {
    throw new EvidenceReviewValidationError(
      'Staff review requires a validated target and concern.',
    );
  }
  return result(context.input, target, {
    disposition: 'staff_review',
    confidence: strongest.confidence,
    observedFacts: context.observedFacts,
    limitations: context.limitations,
    missingEvidence: [],
    summary: staffSummary(target.value, strongest, context.observedFacts),
  });
}

function moreEvidenceResult(
  context: ReviewContext,
): TicketEvidenceReviewResult {
  return result(context.input, context.target, {
    disposition: 'needs_more_evidence',
    confidence: context.strongest?.confidence ?? 0.7,
    observedFacts: context.observedFacts,
    limitations: context.limitations,
    missingEvidence: context.missingEvidence,
    summary:
      'There is a possible moderation concern, but the available evidence is not strong enough for a compact staff escalation yet.',
  });
}

function weakConcernResult(
  context: ReviewContext,
): TicketEvidenceReviewResult {
  const confidence = context.strongest?.confidence ?? 0;
  return result(context.input, context.target, {
    disposition: 'no_escalation',
    confidence: 1 - confidence,
    observedFacts: context.observedFacts,
    limitations: context.limitations,
    missingEvidence: [],
    summary:
      'The current rule-aware concern is too weak to justify staff escalation.',
  });
}

function result(
  input: TicketEvidenceReviewInput,
  target: ReturnType<typeof ticketReportTarget>,
  values: {
    disposition: TicketEvidenceReviewResult['disposition'];
    confidence: number;
    summary: string;
    observedFacts: string[];
    limitations: string[];
    missingEvidence: string[];
  },
): TicketEvidenceReviewResult {
  return {
    disposition: values.disposition,
    target,
    confidence: clampConfidence(values.confidence),
    summary: truncate(values.summary, MAX_SUMMARY_CHARS),
    observedFacts: values.observedFacts,
    concerns: [...input.concerns],
    limitations: values.limitations,
    missingEvidence: boundedUnique(values.missingEvidence, MAX_MISSING),
    moderationState: input.moderationState,
    shouldEscalate: values.disposition === 'staff_review',
  };
}

function validateModerationTarget(
  target: string | null,
  state: AuthoritativeModerationState,
): void {
  if (state.availability === 'unavailable') return;
  if (target === null) return;
  if (state.target.toLowerCase() === target.toLowerCase()) return;
  throw new EvidenceReviewValidationError(
    'Authoritative moderation state does not match the ticket report target.',
  );
}

function validateEvidenceProvenance(
  ticket: TicketContextBundle,
  evidence: TicketImageAssessmentRecord[],
): void {
  const attachments = ticketAttachmentKeys(ticket);
  const refs = new Set<string>();
  for (const item of evidence) {
    if (!/^[a-f0-9]{64}$/.test(item.evidenceSha256)) {
      throw new EvidenceReviewValidationError(
        'Image evidence requires a canonical SHA-256 provenance hash.',
      );
    }
    if (!attachments.has(attachmentKey(item.messageId, item.attachmentId))) {
      throw new EvidenceReviewValidationError(
        'Image evidence is not linked to an attachment in this ticket context.',
      );
    }
    if (refs.has(item.evidenceRef)) {
      throw new EvidenceReviewValidationError(
        'Duplicate image evidence reference.',
      );
    }
    refs.add(item.evidenceRef);
  }
}

function ticketAttachmentKeys(ticket: TicketContextBundle): Set<string> {
  const keys = new Set<string>();
  for (const message of ticket.messages) {
    for (const attachment of safeAttachments(message.attachments)) {
      keys.add(attachmentKey(message.id, attachment.id));
    }
  }
  return keys;
}

function safeAttachments(
  attachments: TicketAttachment[] | undefined,
): TicketAttachment[] {
  return attachments ?? [];
}

function attachmentKey(messageId: string, attachmentId: string): string {
  return `${messageId}\0${attachmentId}`;
}

function validateConcerns(
  concerns: EvidencePolicyConcern[],
  evidence: TicketImageAssessmentRecord[],
): void {
  const evidenceRefs = new Set(evidence.map((item) => item.evidenceRef));
  for (const concern of concerns) {
    if (
      !Number.isFinite(concern.confidence) ||
      concern.confidence < 0 ||
      concern.confidence > 1
    ) {
      throw new EvidenceReviewValidationError(
        'Policy concern confidence must be between 0 and 1.',
      );
    }
    if (concern.evidenceRefs.some((ref) => !evidenceRefs.has(ref))) {
      throw new EvidenceReviewValidationError(
        'Policy concern references evidence outside this ticket review.',
      );
    }
  }
}

function directObservedFacts(
  evidence: TicketImageAssessmentRecord[],
): string[] {
  return boundedUnique(
    evidence.flatMap((item) =>
      item.assessment.observations
        .filter((observation) => observation.confidence >= DIRECT_OBSERVATION_CONFIDENCE)
        .map((observation) => observation.text),
    ),
    MAX_FACTS,
  );
}

function strongestConcern(
  concerns: EvidencePolicyConcern[],
): EvidencePolicyConcern | null {
  return concerns.reduce<EvidencePolicyConcern | null>((strongest, current) => {
    if (strongest === null) return current;
    if (current.confidence > strongest.confidence) return current;
    if (
      current.confidence === strongest.confidence &&
      severityRank(current.severity) > severityRank(strongest.severity)
    ) {
      return current;
    }
    return strongest;
  }, null);
}

function concernHasDirectObservation(
  concern: EvidencePolicyConcern,
  evidence: TicketImageAssessmentRecord[],
): boolean {
  const selected = evidence.filter((item) =>
    concern.evidenceRefs.includes(item.evidenceRef),
  );
  if (selected.length === 0) return false;
  return selected.some((item) =>
    item.assessment.observations.some(
      (observation) => observation.confidence >= DIRECT_OBSERVATION_CONFIDENCE,
    ),
  );
}

function missingEvidenceFor(
  evidence: TicketImageAssessmentRecord[],
  limitations: string[],
  concern: EvidencePolicyConcern | null,
): string[] {
  const missing = [...limitations];
  if (evidence.some((item) => item.assessment.needsMoreContext)) {
    missing.push(
      'Provide a wider or clearer view that includes the surrounding context.',
    );
  }
  if (concern !== null && !concernHasDirectObservation(concern, evidence)) {
    missing.push(
      'Provide directly observable evidence supporting the suspected policy concern.',
    );
  }
  return boundedUnique(missing, MAX_MISSING);
}

function staffSummary(
  target: string,
  concern: EvidencePolicyConcern,
  observedFacts: string[],
): string {
  const facts =
    observedFacts.length === 0
      ? 'No high-confidence direct observation was preserved.'
      : observedFacts.slice(0, 3).join(' | ');
  return truncate(
    `Review ${target}: ${concern.label} (${Math.round(concern.confidence * 100)}% advisory confidence). Evidence: ${facts}. AI analysis is advisory; staff retains punishment authority.`,
    MAX_SUMMARY_CHARS,
  );
}

function isDuplicate(state: AuthoritativeModerationState): boolean {
  return (
    state.availability === 'verified' &&
    state.duplicateStatus !== 'none'
  );
}

function severityRank(
  severity: EvidencePolicyConcern['severity'],
): number {
  switch (severity) {
    case 'low': return 1;
    case 'medium': return 2;
    case 'high': return 3;
    case 'critical': return 4;
  }
}

function boundedUnique(values: string[], maximum: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= maximum) break;
  }
  return result;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return value.slice(0, maximum - 1) + '…';
}
