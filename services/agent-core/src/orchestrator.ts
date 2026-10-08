/**
 * @enthusia/agent-core — agent orchestrator (W12).
 *
 * Spec §15.1 default loop, implemented end to end:
 *
 * 1. understand intent (intent.ts — reasoner proposes, orchestrator validates);
 * 2. identify claims needed to answer (classification);
 * 3. identify relevant context (classification.needsPrivateContext);
 * 4. select authoritative sources (evidence-plan.ts);
 * 5. retrieve/verify (investigation.ts — bounded loop);
 * 6. inspect contradictions or missing data (verification.ts);
 * 7. expand search if needed (investigation.ts auto-expansion);
 * 8. decide local answer versus escalation (escalation.ts — policy, not confidence);
 * 9. produce response (response.ts — deterministic assembly);
 * 10. record evidence-backed memory proposals (memory-updates.ts — propose,
 *    never write; W05 owns writes).
 *
 * Hard guarantees:
 * - every loop is bounded (budget.ts): the orchestrator cannot loop
 *   indefinitely, whatever the reasoner proposes;
 * - mutable Enthusia facts are only asserted with current evidence;
 *   otherwise the answer says "could not verify";
 * - privacy-sensitive tools are refused unless the request needs private
 *   context;
 * - escalation is policy-driven (§15.4: never confidence-only).
 */
import { canDisclose, isValidTraceId, newTraceId } from '@enthusia/contracts';
import { chatRequestSchema } from '@enthusia/contracts';
import type {
  AgentResponse,
  ChatRequest,
  MemoryUpdateProposal,
} from '@enthusia/contracts';
import { BudgetTracker, policyForRequestClass, type BudgetOverrides } from './budget.js';
import { buildEvidencePlan } from './evidence-plan.js';
import { classifyIntent } from './intent.js';
import {
  runInvestigation,
  type InvestigationOutcome,
  type TerminationReason,
} from './investigation.js';
import {
  decideEscalation,
  packetRefFor,
  type EscalationDecision,
} from './escalation.js';
import {
  buildInvestigationPacket,
  type InvestigationPacket,
} from './packet.js';
import {
  normalizeMemoryProposals,
  proposalFromSuperseded,
} from './memory-updates.js';
import { assembleResponse } from './response.js';
import {
  TOPIC_FAMILIARITY_TOOL,
  resolveResponseStyle,
} from './response-style.js';
import { assessAllClaims, assessAllClaimsDisclosable } from './verification.js';
import type { Reasoner } from './reasoner.js';
import { TimeoutReasoner } from './reasoner.js';
import type { ToolRegistry } from './tool.js';
import type {
  ClaimAssessment,
  IntentClassification,
  ResolvedChatRequest,
  ResponseStyleProfile,
} from './types.js';

/** Dependencies injected into the orchestrator (all seams are DI). */
export interface VerifiedTopicHelpEvent {
  actor: ResolvedChatRequest['actor'];
  topic: string;
  conversationId: string;
  traceId: string;
  observedAt: string;
  supportedDirectClaims: number;
}

export interface OrchestratorDeps {
  /** Local-model reasoner (W03-backed in production, mocked in tests). */
  reasoner: Reasoner;
  /** Tool registry (W05/W07/W08/W10/W11 tools plug in here). */
  registry: ToolRegistry;
  /** Epoch-millis clock (injectable for tests). */
  nowMs?: () => number;
  /** Per-request-class budget overrides. */
  policyOverrides?: BudgetOverrides;
  /** Consecutive tool failures before `repeated_tool_failures` (§22.1). */
  maxConsecutiveFailures?: number;
  /** Per-tool execution timeout, milliseconds. */
  toolTimeoutMs?: number;
  /** Bound for classify/plan/draft reasoner calls, milliseconds. */
  reasonerTimeoutMs?: number;
  /** Hook receiving the W13 investigation packet on openai escalations. */
  onPacket?: (packet: InvestigationPacket) => void;
  /** Internal logging hook; never sends errors or messages to staff. */
  onUnhandledError?: (error: unknown, traceId: string) => void;
  /** Explicitly injected, public-only test source; null defers to normal agent. */
  publicSourceResolver?: (request: ResolvedChatRequest) => Promise<AgentResponse | null>;
  /**
   * Best-effort deterministic learning hook for topic-specific response style.
   * It receives no raw message or memory text.
   */
  onVerifiedTopicHelp?: (
    event: VerifiedTopicHelpEvent,
  ) => Promise<void> | void;
}

/** Default bound for non-loop reasoner calls. */
export const DEFAULT_REASONER_TIMEOUT_MS = 30_000;

/**
 * Resolve the request's trace ID: reuse the caller's when it is a valid
 * UUID, otherwise generate one (contracts/trace convention).
 */
export function resolveTraceId(request: ChatRequest): string {
  const candidate = request.traceId;
  if (typeof candidate === 'string' && isValidTraceId(candidate)) {
    return candidate;
  }
  return newTraceId();
}

/**
 * Heuristic: did the actor explicitly ask for a deep investigation?
 * (§22.1 "owner/staff explicitly requests deep investigation".)
 * Surface adapters (W02/W06) may set this explicitly in the future; the
 * keyword heuristic is a documented fallback, not model output.
 */
export function wantsDeepInvestigation(message: string): boolean {
  return /\bdeep[-\s]?dive\b|\bdeep investigation\b|\binvestigate thoroughly\b|\bthorough investigation\b/i.test(
    message,
  );
}

/** The agent orchestrator: the local AI's investigative behavior. */
export class AgentOrchestrator {
  private readonly nowMs: () => number;
  private readonly reasonerTimeoutMs: number;

  constructor(private readonly deps: OrchestratorDeps) {
    if (!deps.reasoner) {
      throw new Error('AgentOrchestrator requires a reasoner');
    }
    if (!deps.registry) {
      throw new Error('AgentOrchestrator requires a tool registry');
    }
    this.nowMs = deps.nowMs ?? Date.now;
    this.reasonerTimeoutMs =
      deps.reasonerTimeoutMs ?? DEFAULT_REASONER_TIMEOUT_MS;
  }

  /**
   * Handle one chat request end to end, returning an {@link AgentResponse}.
   * Never throws: unexpected failures return a truthful generic error;
   * staff must not be told they were notified unless a real notification ran.
   */
  async handleChat(request: ChatRequest): Promise<AgentResponse> {
    const traceId = resolveTraceId(request);
    try {
      chatRequestSchema.parse(request); // throws on malformed requests
      const resolved: ResolvedChatRequest = { ...request, traceId };
      if (this.deps.publicSourceResolver !== undefined) {
        const publicAnswer = await this.deps.publicSourceResolver(resolved);
        if (publicAnswer !== null) return publicAnswer;
      }
      return await this.run(resolved);
    } catch (err) {
      try {
        this.deps.onUnhandledError?.(err, traceId);
      } catch {
        // Logging must never block the user-facing error response.
      }
      return {
        text: 'I could not finish that request. Please try again in a moment.',
        actions: [],
        sources: [],
        memoryUpdates: [],
        escalation: null,
        traceId,
      };
    }
  }

  private async run(request: ResolvedChatRequest): Promise<AgentResponse> {
    const { reasoner, registry } = this.deps;

    // 1. Understand intent.
    let preReasonerCalls = 0;
    const preAccounting = {
      recordReasonerCalls: (n = 1): void => {
        preReasonerCalls += n;
      },
    };
    const classification = await this.withReasonerTimeout(
      classifyIntent(reasoner, request, preAccounting),
      'classifyIntent',
    );

    // 2–4. Budget, evidence plan.
    const policy = policyForRequestClass(
      classification.requestClass,
      this.deps.policyOverrides,
    );
    const budget = new BudgetTracker(policy);
    budget.recordReasonerCalls(preReasonerCalls);

    let responseStyle: ResponseStyleProfile | undefined;
    const wantsFamiliarity =
      classification.needsFamiliarityContext === true &&
      request.actor.type === 'player';
    const hasFamiliarityTool = registry.has(TOPIC_FAMILIARITY_TOOL);
    if (
      wantsFamiliarity &&
      (!hasFamiliarityTool || budget.canCallTools(1))
    ) {
      responseStyle = await resolveResponseStyle(request, classification, {
        registry,
        ...(this.deps.toolTimeoutMs !== undefined
          ? { toolTimeoutMs: this.deps.toolTimeoutMs }
          : {}),
      });
      if (hasFamiliarityTool) {
        budget.recordToolCalls(1);
      }
    }

    const { steps: plan, warnings: planWarnings } = await this.withReasonerTimeout(
      buildEvidencePlan(reasoner, request, classification, registry, budget),
      'buildEvidencePlan',
    );

    // 5–7. Bounded investigation loop.
    const outcome = await runInvestigation(
      { request, classification, plan },
      {
        reasoner: new TimeoutReasoner(reasoner, this.reasonerTimeoutMs),
        registry,
        policy,
        budget,
        nowMs: this.nowMs,
        ...(this.deps.maxConsecutiveFailures !== undefined
          ? { maxConsecutiveFailures: this.deps.maxConsecutiveFailures }
          : {}),
        ...(this.deps.toolTimeoutMs !== undefined
          ? { toolTimeoutMs: this.deps.toolTimeoutMs }
          : {}),
        verification: { nowMs: this.nowMs() },
      },
    );

    // 6. Verify claims against evidence (deterministic, not model-driven).
    // Full-evidence assessments drive escalation, packets, and memory
    // proposals; the response text uses only actor-disclosable evidence so
    // above-ceiling values are never asserted or leaked (§17).
    const assessments = assessAllClaims(classification.claims, outcome.evidence);
    const disclosure = {
      ceiling: request.visibilityCeiling,
      isStaff: request.actor.type === 'staff',
    };
    const visibleAssessments = assessAllClaimsDisclosable(
      classification.claims,
      outcome.evidence,
      disclosure,
    );
    const visibleEvidence = outcome.evidence.filter((item) =>
      canDisclose(item.visibility, disclosure.ceiling, {
        isStaff: disclosure.isStaff,
      }),
    );

    // 8. Escalation decision (policy-driven).
    const escalation: EscalationDecision | null = decideEscalation({
      request,
      classification,
      outcome,
      assessments,
      explicitDeepInvestigation:
        request.actor.type === 'staff' && wantsDeepInvestigation(request.message),
      ...(this.deps.maxConsecutiveFailures !== undefined
        ? { maxConsecutiveFailures: this.deps.maxConsecutiveFailures }
        : {}),
    });
    if (escalation && escalation.target === 'openai') {
      const packet = buildInvestigationPacket({
        request,
        classification,
        outcome,
        assessments,
        packetRef: escalation.packetRef ?? packetRefFor(request.traceId),
      });
      try {
        this.deps.onPacket?.(packet);
      } catch {
        // Packet delivery must not fail the response.
      }
    }

    // 10. Memory update proposals (propose — W05 owns writes).
    const memoryProposals = this.collectMemoryProposals(outcome, assessments);

    // 9. Assemble the response (deterministic; disclosable evidence only).
    budget.recordReasonerCalls(1);
    const draft = await this.withReasonerTimeout(
      reasoner.draftResponse({
        request,
        classification,
        factualLines: visibleAssessments.map((a) => factualLine(a)),
        evidence: visibleEvidence,
        escalated: escalation !== null,
        ...(responseStyle !== undefined ? { responseStyle } : {}),
      }),
      'draftResponse',
    );

    const response = assembleResponse({
      request,
      assessments: visibleAssessments,
      evidence: outcome.evidence,
      escalation,
      memoryProposals,
      draft,
      ...(classification.backgroundClaims !== undefined
        ? { backgroundClaims: classification.backgroundClaims }
        : {}),
      ...(responseStyle !== undefined ? { responseStyle } : {}),
      notes: [
        ...planWarnings.map((w) => `plan: ${w}`),
        ...terminationNote(outcome.termination),
      ],
    });

    const verifiedHelp = verifiedTopicHelpEvent(
      request,
      classification,
      visibleAssessments,
      this.nowMs(),
    );
    if (verifiedHelp !== null && this.deps.onVerifiedTopicHelp !== undefined) {
      try {
        await this.deps.onVerifiedTopicHelp(verifiedHelp);
      } catch {
        // Familiarity learning is best-effort and must never fail the answer.
      }
    }

    return response;
  }

  private collectMemoryProposals(
    outcome: InvestigationOutcome,
    assessments: ClaimAssessment[],
  ): MemoryUpdateProposal[] {
    const proposals: MemoryUpdateProposal[] = [...outcome.memoryProposals];
    for (const assessment of assessments) {
      for (const superseded of assessment.supersededMemories) {
        proposals.push(proposalFromSuperseded(superseded));
      }
    }
    return normalizeMemoryProposals(proposals, outcome.evidence);
  }

  private async withReasonerTimeout<T>(
    promise: Promise<T>,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`reasoner call timed out: ${label}`),
              ),
            this.reasonerTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

function verifiedTopicHelpEvent(
  request: ResolvedChatRequest,
  classification: IntentClassification,
  assessments: ClaimAssessment[],
  nowMs: number,
): VerifiedTopicHelpEvent | null {
  if (
    request.actor.type !== 'player' ||
    classification.needsFamiliarityContext !== true ||
    classification.familiarityTopic === undefined
  ) {
    return null;
  }

  const background = new Set(classification.backgroundClaims ?? []);
  const supportedDirectClaims = assessments.filter(
    (assessment) =>
      assessment.verdict === 'supported' &&
      !background.has(assessment.claim),
  ).length;
  if (supportedDirectClaims === 0) return null;

  return {
    actor: request.actor,
    topic: classification.familiarityTopic,
    conversationId: request.conversationId,
    traceId: request.traceId,
    observedAt: new Date(nowMs).toISOString(),
    supportedDirectClaims,
  };
}

/** Read-only factual context handed to the reasoner for draft framing. */
function factualLine(assessment: ClaimAssessment): string {
  switch (assessment.verdict) {
    case 'supported':
      return `${assessment.claim}: ${assessment.assertedValue ?? '(no value)'}`;
    case 'unsupported':
      return `could not verify: ${assessment.claim}`;
    case 'contradicted':
      return `conflicting evidence: ${assessment.claim}`;
  }
}

/** User-facing notes for non-clean investigation terminations. */
function terminationNote(termination: TerminationReason): string[] {
  switch (termination) {
    case 'evidence_complete':
      return [];
    case 'budget_exhausted':
      return [
        'the investigation reached its tool budget; the answer covers what could be verified in time',
      ];
    case 'repeated_tool_failures':
      return ['some local tools failed repeatedly during the investigation'];
    case 'timeout':
      return ['the investigation timed out; the answer covers what was verified so far'];
    case 'privacy_blocked':
      return [
        'some checks were skipped because they needed private context this request does not require',
      ];
    case 'reasoner_error':
      return ['the investigation was interrupted; the answer covers what was verified so far'];
  }
}

/** Re-exported for tests and for W13 (packet consumer). */
export type { InvestigationPacket, IntentClassification };
