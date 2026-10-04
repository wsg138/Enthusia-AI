/**
 * @enthusia/agent-core — core orchestration types (W12).
 *
 * Spec: MASTER-SPECIFICATION.md §§11 (verification), 15 (agent reasoning),
 * 16 (tool system), 17 (visibility), 22 (escalation), 78 (tool budgets);
 * WORKER-EXECUTION-PLAN.md §15 (W12 owns: intent, evidence plan, tool
 * selection, investigation loop, tool budgets, claim verification, escalation
 * decision, response assembly, memory update proposals).
 *
 * Boundary note: this package consumes `@enthusia/contracts` (W01) as-is.
 * Where the wire contracts are lossy for orchestration internals (e.g.
 * `ToolResult.freshness` is a free-form string; `Escalation.target` is only
 * `human | strong-model`), agent-core defines richer internal types and maps
 * to the wire shape at the response boundary. Contracts are never modified.
 */
import type {
  Actor,
  ChatRequest,
  MemoryUpdateProposal,
  Visibility,
} from '@enthusia/contracts';
import type { MemoryRevisionStatus, SourceStatus } from '@enthusia/contracts';

/**
 * Trace ID convention (contracts/trace): UUID v4 string, generated at
 * ingress and propagated through every tool call. `ChatRequest.traceId` is
 * optional; the orchestrator generates one when absent.
 */
export type TraceId = string;

/**
 * Request classes for tool budgets — Master Specification §78.
 *
 * - `simple`: small retrieval/tool budget (e.g. "what is the server IP?");
 * - `investigative`: larger bounded budget (e.g. permission debugging);
 * - `engineering`: gather evidence, then escalate with a packet for W13.
 */
export type RequestClass = 'simple' | 'investigative' | 'engineering';

export const REQUEST_CLASSES: readonly RequestClass[] = [
  'simple',
  'investigative',
  'engineering',
] as const;

/** Type guard for request classes (validates model-produced values). */
export function isRequestClass(value: unknown): value is RequestClass {
  return (
    typeof value === 'string' &&
    (REQUEST_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * Verification tier of a source — Master Specification §11.2.
 *
 * - A: live lookup (volatile or player-specific);
 * - B: verified indexed source (hash/versioned);
 * - C: current structured memory (with evidence/provenance).
 *
 * Tier D (model knowledge) is never authoritative for mutable Enthusia facts
 * and therefore has no representation here.
 */
export type VerificationTier = 'A' | 'B' | 'C';

export const VERIFICATION_TIERS: readonly VerificationTier[] = [
  'A',
  'B',
  'C',
] as const;

/** Numeric strength of a verification tier (higher wins conflicts). */
export function verificationTierRank(tier: VerificationTier): number {
  switch (tier) {
    case 'A':
      return 3;
    case 'B':
      return 2;
    case 'C':
      return 1;
  }
}

/**
 * Internal escalation target. Mapped to the wire `Escalation` contract at
 * the response boundary: `openai` → `strong-model`, `staff`/`owner` →
 * `human` (§5.9, §22).
 */
export type EscalationTarget = 'openai' | 'staff' | 'owner';

export const ESCALATION_TARGETS: readonly EscalationTarget[] = [
  'openai',
  'staff',
  'owner',
] as const;

/** Type guard for escalation targets (validates model-produced values). */
export function isEscalationTarget(value: unknown): value is EscalationTarget {
  return (
    typeof value === 'string' &&
    (ESCALATION_TARGETS as readonly string[]).includes(value)
  );
}

/**
 * Intent classification produced by the reasoner (local model via W03).
 *
 * The orchestrator validates every field before use: model output is data,
 * never control flow (§15.4 — policy is enforced by this package).
 */
export interface IntentClassification {
  requestClass: RequestClass;
  /** One-line summary of what the user wants. */
  summary: string;
  /** Mutable Enthusia facts the answer will need to assert (§11.1). */
  claims: string[];
  /** True when answering legitimately requires identity/private context. */
  needsPrivateContext: boolean;
  /** True when the request is security-sensitive (escalation input, §22.1). */
  securitySensitive: boolean;
  /** Model's own reasoning, retained for audit logging. */
  reasoning?: string;
}

/**
 * One step of the evidence plan: which claim needs which evidence (§15.1).
 *
 * Produced by the reasoner, validated by the orchestrator. Tools are chosen
 * from the injected registry — never invented by the model.
 */
export interface EvidencePlanStep {
  claim: string;
  /** Tool names to try, in priority order. Must exist in the registry. */
  candidateTools: string[];
  /** Strongest verification tier acceptable for this claim (§11.2). */
  verificationTier: VerificationTier;
  /** True when this step may read private/identity-scoped data. */
  privacySensitive: boolean;
  /**
   * Default params for auto-expanded calls (§15.1 step 7). When the
   * orchestrator expands the search on its own, it calls the next untried
   * candidate tool with these params (validated like any other call).
   */
  params?: Record<string, unknown>;
}

/** Memory identity carried by memory-backed evidence (W05). */
export interface MemoryIdentity {
  /** Stable memory key id, e.g. the W05 MemoryKey id. */
  keyId: string;
  namespace?: string;
  key?: string;
  scope?: string;
  /** Lifecycle status of the memory revision at read time. */
  status?: MemoryRevisionStatus;
}

/**
 * Convention for tool payloads that carry claim evidence.
 *
 * Tools that can answer factual claims return a payload shaped like this
 * (or a bare string, treated as the value). Anything else is recorded in the
 * investigation trace but does not count as claim evidence.
 */
export interface ClaimEvidencePayload {
  /** The asserted value for the claim, e.g. "play.enthusia.gg". */
  value: string;
  /** Optional longer excerpt for citations. */
  excerpt?: string;
  /** Set when the evidence came from a memory revision (W05). */
  memory?: MemoryIdentity;
}

/**
 * One verified/unverified piece of evidence attached to a claim (§11.3).
 *
 * Conceptually: claim -> source -> version/time -> tier -> visibility.
 */
export interface EvidenceItem {
  /** Unique within one investigation (for citations and packets). */
  id: string;
  claim: string;
  /** Normalized asserted value (trimmed; comparison uses a folded form). */
  value: string;
  toolName: string;
  /** Subsystem/source that produced the result (envelope `source`). */
  source: string;
  visibility: Visibility;
  verificationTier: VerificationTier;
  /** Version fingerprint of the underlying source, when known. */
  version?: string;
  /** ISO-8601 time the source was observed. */
  observedTime?: string;
  /** Lifecycle status of the source version. */
  sourceStatus?: SourceStatus;
  excerpt?: string;
  /**
   * Whether this item counts as *current* evidence (§11): it has provenance,
   * its source version is CURRENT, and (for live tier-A sources) it was
   * observed recently. Only current evidence may ground a factual answer.
   */
  current: boolean;
  /** Memory identity when the source is memory (W05). */
  memory?: MemoryIdentity;
}

/** Verdict of claim verification — computed by the orchestrator, not the model. */
export type ClaimVerdict = 'supported' | 'unsupported' | 'contradicted';

/**
 * A memory revision contradicted by stronger current evidence (§5.3, §13.9).
 * Feeds memory *proposals* — W05 owns the actual write.
 */
export interface SupersededMemory {
  memoryKeyId: string;
  memoryNamespace?: string;
  memoryKey?: string;
  memoryScope?: string;
  oldValue: string;
  newValue: string;
  evidenceIds: string[];
}

/** Orchestrator-computed assessment of one claim against gathered evidence. */
export interface ClaimAssessment {
  claim: string;
  verdict: ClaimVerdict;
  /** Current evidence backing the asserted value. */
  supporting: EvidenceItem[];
  /** Current evidence that disagrees (populated on contradiction). */
  contradicting: EvidenceItem[];
  /** The value the response may assert (only when supported). */
  assertedValue?: string;
  /** Memories the evidence shows are stale (→ proposals, never direct writes). */
  supersededMemories: SupersededMemory[];
}

/** Two or more current sources disagree about a claim. */
export interface Contradiction {
  claim: string;
  items: EvidenceItem[];
  description: string;
}

/** A tool call proposed by the reasoner. */
export interface ToolCallProposal {
  toolName: string;
  params: Record<string, unknown>;
  /** Which claim this call serves (should match the evidence plan). */
  claim?: string;
  rationale?: string;
}

/** A tool call that was executed (or refused) by the orchestrator. */
export interface ExecutedToolCall {
  toolName: string;
  params: Record<string, unknown>;
  claim?: string;
  /** False when the tool threw or returned an error envelope. */
  ok: boolean;
  /** True when the orchestrator refused to run the tool (privacy/budget/unknown). */
  blocked: boolean;
  /** Why the call was blocked, when blocked. */
  blockReason?: string;
  durationMs: number;
  /** Tool-reported error code, when the call failed. */
  errorCode?: string;
}

/** Read-only snapshot handed to the reasoner for the next-step decision. */
export interface InvestigationSnapshot {
  request: ChatRequest;
  classification: IntentClassification;
  plan: EvidencePlanStep[];
  evidence: EvidenceItem[];
  contradictions: Contradiction[];
  executedCalls: ExecutedToolCall[];
  consecutiveFailures: number;
  budget: {
    toolCallsRemaining: number;
    iterationsRemaining: number;
    reasonerCallsRemaining: number;
  };
}

/** Conversational framing from the reasoner (never carries factual claims). */
export interface ResponseDraft {
  preamble?: string;
  closing?: string;
}

/** Escalation hint from the reasoner — advisory only, mapped through policy. */
export interface EscalationHint {
  target: EscalationTarget;
  reason: string;
}

/** Re-exported contract types used across the package. */
export type { Actor, ChatRequest, MemoryUpdateProposal, Visibility };

/**
 * A chat request with a guaranteed trace ID. The orchestrator resolves
 * `ChatRequest.traceId` (optional in the wire contract) once per request —
 * generating one via `newTraceId()` when absent — and threads the resolved
 * form through investigation, tools, and the response.
 */
export type ResolvedChatRequest = ChatRequest & { traceId: string };
