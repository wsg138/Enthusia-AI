/**
 * @enthusia/openai-gateway — escalation policy adapter (W13).
 *
 * Consumes W12's escalation decision and decides whether the OpenAI
 * escalation path may be used, enforcing MASTER-SPECIFICATION.md §22.1
 * triggers, the §37 "maximum escalation calls per request" control, and
 * packet↔decision consistency. Policy-driven, never confidence-driven.
 *
 * W12 owns the decision itself (decideEscalation); this adapter owns the
 * W13-side gate.
 */
import type { EscalationKind } from './models.js';
import type { InvestigationPacket } from './packet.js';

/**
 * W12's escalation decision shape (structural — W12 owns the decider).
 * Only target 'openai' may reach the OpenAI gateway.
 */
export interface EscalationDecision {
  target: 'openai' | 'staff' | 'owner';
  reason: string;
  /** Set by W12 when a W13 investigation packet was built for this escalation. */
  packetRef?: string;
}

export type EscalationDenialCode =
  | 'not_openai_target'
  | 'packet_ref_mismatch'
  | 'max_escalations_per_request'
  | 'coding_actor_not_authorized';

/** Thrown (never silent) when the escalation is not permitted. */
export class EscalationDeniedError extends Error {
  readonly code: EscalationDenialCode;

  constructor(code: EscalationDenialCode, detail: string) {
    super(`Escalation denied (${code}): ${detail}`);
    this.name = 'EscalationDeniedError';
    this.code = code;
  }
}

export interface PolicyCheckInput {
  decision: EscalationDecision;
  packet: InvestigationPacket;
  /** OpenAI escalations already consumed for this traceId (§37). */
  escalationsUsedForTrace: number;
  maxEscalationsPerRequest: number;
  modelSelection: Record<EscalationKind, string>;
}

/** A permitted escalation: which kind of work and which model to use. */
export interface AuthorizedEscalation {
  kind: EscalationKind;
  model: string;
  /** The §22.1 trigger this escalation was authorized under. */
  trigger: string;
}

/**
 * Classify the kind of stronger-model work from the packet and decision.
 * Deterministic: request class first, then keyword signals from the
 * investigation content.
 */
export function classifyEscalationKind(
  packet: InvestigationPacket,
  decisionReason: string,
): EscalationKind {
  if (packet.requestClass === 'engineering') {
    return 'coding';
  }
  const haystack =
    `${packet.goal} ${packet.userQuestion} ${decisionReason} ` +
    packet.unresolvedQuestions.join(' ');
  const text = haystack.toLowerCase();

  if (text.includes('architect') || text.includes('refactor')) {
    return 'architecture';
  }
  if (text.includes('secur') || packet.requestClass === 'security') {
    return 'analysis';
  }
  if (
    text.includes('debug') ||
    (text.includes('repeated') && text.includes('fail'))
  ) {
    return 'debugging';
  }
  return 'investigation';
}

/**
 * Gate the escalation. Returns the authorized kind/model, or throws
 * EscalationDeniedError with a machine-readable code.
 */
export function authorizeEscalation(
  input: PolicyCheckInput,
): AuthorizedEscalation {
  const { decision, packet } = input;

  if (decision.target !== 'openai') {
    throw new EscalationDeniedError(
      'not_openai_target',
      `decision targets '${decision.target}', not the OpenAI path (§22.1).`,
    );
  }

  if (
    decision.packetRef !== undefined &&
    decision.packetRef !== packet.packetRef
  ) {
    throw new EscalationDeniedError(
      'packet_ref_mismatch',
      `decision packetRef '${decision.packetRef}' does not match packet '${packet.packetRef}'.`,
    );
  }

  if (input.escalationsUsedForTrace >= input.maxEscalationsPerRequest) {
    throw new EscalationDeniedError(
      'max_escalations_per_request',
      `already used ${input.escalationsUsedForTrace} of ${input.maxEscalationsPerRequest} escalations for this request (§37).`,
    );
  }

  const kind = classifyEscalationKind(packet, decision.reason);
  if (
    kind === 'coding' &&
    packet.authorization.actorKind !== 'staff' &&
    packet.authorization.actorKind !== 'system'
  ) {
    throw new EscalationDeniedError(
      'coding_actor_not_authorized',
      'coding escalation is separated from player chat and requires staff/system authorization (§37).',
    );
  }
  const model = input.modelSelection[kind];

  return {
    kind,
    model,
    trigger: decision.reason,
  };
}
