/**
 * @enthusia/agent-core — escalation decision (W12).
 *
 * Spec: MASTER-SPECIFICATION.md §22 (OpenAI escalation), §22.1
 * (mandatory/strong escalation triggers), §15.4 (no confidence-only routing),
 * §5.9 (stronger models are escalation resources).
 *
 * Escalation is POLICY-driven, never confidence-driven: the decision is a
 * pure function of objective investigation state (request class,
 * contradictions, repeated tool failures, security sensitivity, explicit
 * actor request). The reasoner's `escalationHint` is advisory and is only
 * honored when it maps onto one of these objective triggers.
 *
 * The internal target (`openai` | `staff` | `owner`) is mapped to the wire
 * `Escalation` contract (`strong-model` | `human`) by the orchestrator.
 */
import type {
  ClaimAssessment,
  EscalationTarget,
  IntentClassification,
  ResolvedChatRequest,
} from './types.js';
import type {
  InvestigationOutcome,
  TerminationReason,
} from './investigation.js';
import { DEFAULT_MAX_CONSECUTIVE_FAILURES } from './investigation.js';

/** Internal escalation decision (mapped to the wire contract at the boundary). */
export interface EscalationDecision {
  target: EscalationTarget;
  reason: string;
  /** Set when a W13 investigation packet was built for this escalation. */
  packetRef?: string;
}

export interface EscalationInput {
  request: ResolvedChatRequest;
  classification: IntentClassification;
  outcome: InvestigationOutcome;
  assessments: ClaimAssessment[];
  /**
   * True when the actor explicitly asked for a deep investigation or for a
   * stronger model (§22.1 "owner/staff explicitly requests deep
   * investigation"). Derived by the orchestrator from the request, not from
   * model confidence.
   */
  explicitDeepInvestigation?: boolean;
  maxConsecutiveFailures?: number;
}

/** Deterministic packet reference for an escalation (W13 resolves it). */
export function packetRefFor(traceId: string): string {
  return `packet:${traceId}`;
}

/**
 * Decide whether to escalate and to whom. Returns null when the local
 * answer stands on its own.
 *
 * Trigger mapping (§22.1):
 * - engineering request class → `openai` (code-level work, with packet);
 * - contradictory current evidence → `staff` (human judgment; the
 *   orchestrator must not pick a side randomly);
 * - repeated local tool failures → `openai` (alternate strategy);
 * - security-sensitive request → `staff`;
 * - explicit actor request for deep investigation → `openai`.
 */
export function decideEscalation(input: EscalationInput): EscalationDecision | null {
  const { request, classification, outcome, assessments } = input;
  const maxConsecutiveFailures =
    input.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;

  // 1. Engineering: gather evidence locally, delegate heavy work only for
  // staff/system actors. Player chat must not open an expensive coding path.
  if (classification.requestClass === 'engineering') {
    if (request.actor.type !== 'staff' && request.actor.type !== 'system') {
      return {
        reason:
          'Engineering-class request requires staff authorization before ' +
          'opening the coding escalation path (§37).',
        target: 'staff',
      };
    }
    return {
      reason:
        'Engineering-class request: local evidence gathered; escalating to ' +
        'the stronger model with a structured investigation packet for ' +
        'code-level work (§22.1, §22.2).',
      target: 'openai',
      packetRef: packetRefFor(request.traceId),
    };
  }

  // 2. Contradictory current evidence: surface to a human, never guess.
  const contradicted = assessments.filter(
    (a) => a.verdict === 'contradicted',
  );
  if (contradicted.length > 0) {
    const names = contradicted.map((a) => `"${a.claim}"`).join(', ');
    return {
      reason:
        `Conflicting current evidence for ${names}. Flagged for human ` +
        `review rather than picking a side (§15.1 step 6, §22.1).`,
      target: 'staff',
    };
  }

  // 3. Repeated local tool failures (§22.1).
  const failures = outcome.consecutiveFailures;
  const repeatedFailureTermination: TerminationReason = 'repeated_tool_failures';
  if (
    failures >= maxConsecutiveFailures ||
    outcome.termination === repeatedFailureTermination
  ) {
    return {
      reason:
        `Local tools failed repeatedly (${failures} consecutive failures). ` +
        `Escalating so the stronger model can attempt an alternate strategy (§22.1).`,
      target: 'openai',
      packetRef: packetRefFor(request.traceId),
    };
  }

  // 4. Security-sensitive analysis (§22.1).
  if (classification.securitySensitive) {
    return {
      reason:
        'Security-sensitive request flagged for staff review (§22.1).',
      target: 'staff',
    };
  }

  // 5. Explicit actor request for deep investigation (§22.1).
  if (
    input.explicitDeepInvestigation === true &&
    request.actor.type === 'staff'
  ) {
    return {
      reason:
        'Actor explicitly requested deep investigation; escalating with an ' +
        'investigation packet (§22.1).',
      target: 'openai',
      packetRef: packetRefFor(request.traceId),
    };
  }

  // 6. Advisory reasoner hint: honored only when it restates an objective
  // trigger above. A bare hint with no trigger is NOT escalation-worthy —
  // this is the §15.4 "no confidence-only routing" rule made concrete.
  // (All objective triggers are checked above; reaching here means the hint,
  // if any, maps to nothing objective, so it is ignored.)

  return null;
}

/**
 * Map an internal escalation decision to the wire `Escalation` contract:
 * `openai` → `strong-model`, `staff`/`owner` → `human` (§5.9).
 */
export function toWireEscalation(decision: EscalationDecision): {
  reason: string;
  target: 'human' | 'strong-model';
  context?: Record<string, unknown>;
} {
  return {
    reason: decision.reason,
    target: decision.target === 'openai' ? 'strong-model' : 'human',
    ...(decision.packetRef !== undefined
      ? { context: { packetRef: decision.packetRef } }
      : {}),
  };
}
