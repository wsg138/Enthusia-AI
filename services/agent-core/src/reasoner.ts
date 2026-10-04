/**
 * @enthusia/agent-core — reasoner interface (W12).
 *
 * The "reasoner" is the local model behind the orchestrator, reached through
 * W03's inference adapter. It proposes (intent, evidence plan, next tool
 * calls, conversational framing); the orchestrator disposes (budgets, privacy
 * gate, verification, escalation policy).
 *
 * Design rule (§15.4): the reasoner NEVER decides escalation or factual
 * truth on its own. Its outputs are validated data, and every consequential
 * decision — budget exhaustion, privacy refusal, claim verdicts, escalation
 * triggers — is computed deterministically by this package from objective
 * investigation state. Confidence scores are not accepted as routing inputs.
 *
 * Production wiring: implement this interface with W03's `InferenceClient`
 * by prompting the local model for strict JSON matching these shapes and
 * validating the parse. That adapter lives outside this package so unit
 * tests run with zero model calls (mocked reasoner).
 */
import type { ChatRequest } from '@enthusia/contracts';
import type {
  EscalationHint,
  EvidenceItem,
  EvidencePlanStep,
  IntentClassification,
  InvestigationSnapshot,
  MemoryUpdateProposal,
  ResponseDraft,
  ToolCallProposal,
  ClaimVerdict,
} from './types.js';
import type { ToolMetadata } from './tool.js';

/** The reasoner's read of one claim — advisory only, never asserted verbatim. */
export interface ClaimHint {
  claim: string;
  verdict: ClaimVerdict;
  note?: string;
}

/**
 * The reasoner's next-step decision for the investigation loop.
 *
 * `action: 'call_tools'` with an empty `calls` list is treated as finish.
 * The orchestrator may still auto-expand the search (§15.1 step 7) when
 * evidence is incomplete and the plan lists untried tools.
 */
export interface InvestigationDecision {
  action: 'call_tools' | 'finish';
  calls: ToolCallProposal[];
  /** Advisory read of claim states (used for diagnosis/packets, not answers). */
  claimHints?: ClaimHint[];
  /** Candidate memory changes — validated and proposed, never written (§13). */
  memoryProposals?: MemoryUpdateProposal[];
  /** Advisory escalation suggestion — mapped through policy, never trusted raw. */
  escalationHint?: EscalationHint;
  /** Free-form note for the investigation trace. */
  note?: string;
}

/** Arguments for drafting conversational framing (no factual claims). */
export interface DraftArgs {
  request: ChatRequest;
  classification: IntentClassification;
  /** Factual sentences already assembled by the orchestrator (read-only). */
  factualLines: string[];
  evidence: EvidenceItem[];
  escalated: boolean;
}

/**
 * Narrow model seam. Every method must return validated JSON-shaped data;
 * implementations must throw on unparseable model output so the orchestrator
 * can fail safe (never invent a decision).
 */
export interface Reasoner {
  /** Classify intent → request class, claims, private-context need (§15.1.1). */
  classifyIntent(request: ChatRequest): Promise<IntentClassification>;
  /**
   * Plan evidence: for each claim, which registered tools to try in what
   * order and at which verification tier (§15.1.2–4).
   */
  planEvidence(
    request: ChatRequest,
    classification: IntentClassification,
    availableTools: ToolMetadata[],
  ): Promise<EvidencePlanStep[]>;
  /** Decide the next investigation step from the current snapshot (§15.1.5–7). */
  nextStep(snapshot: InvestigationSnapshot): Promise<InvestigationDecision>;
  /**
   * Draft conversational framing around the orchestrator's factual lines.
   *
   * The draft must not assert factual claims; facts come from the
   * orchestrator's claim assessments. Memory proposals listed here must
   * name their backing evidence in `summary` ("Evidence: <id>, ...") or
   * they are dropped by the orchestrator.
   */
  draftResponse(args: DraftArgs): Promise<ResponseDraft>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`reasoner call timed out: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    // The race keeps the timer alive until one side settles; clear on settle.
    void Promise.resolve(promise).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }
}

/**
 * Reasoner decorator bounding `nextStep` calls. Used by the investigation
 * loop so a hung model call terminates the loop (`reasoner_error`) instead
 * of hanging it — the loop's wall-clock deadline only applies between
 * reasoner calls.
 */
export class TimeoutReasoner implements Reasoner {
  constructor(
    private readonly inner: Reasoner,
    private readonly timeoutMs: number,
  ) {}

  classifyIntent(request: ChatRequest): Promise<IntentClassification> {
    return this.inner.classifyIntent(request);
  }

  planEvidence(
    request: ChatRequest,
    classification: IntentClassification,
    availableTools: ToolMetadata[],
  ): Promise<EvidencePlanStep[]> {
    return this.inner.planEvidence(request, classification, availableTools);
  }

  nextStep(snapshot: InvestigationSnapshot): Promise<InvestigationDecision> {
    return withTimeout(this.inner.nextStep(snapshot), this.timeoutMs, 'nextStep');
  }

  draftResponse(args: DraftArgs): Promise<ResponseDraft> {
    return this.inner.draftResponse(args);
  }
}
