/**
 * @enthusia/training-evaluation — core evaluation types.
 *
 * Spec: MASTER-SPECIFICATION.md §29, TRAINING-AND-EVALUATION-SPEC.md §§11, 12, 20–24.
 *
 * The system-under-test (SUT) interface is intentionally minimal so the
 * evaluator can exercise mock systems today and real agent systems later:
 *
 *     type SystemUnderTest = (question: string, context: EvalContext) => Promise<EvalResponse>;
 */

/** Golden-set categories. Spec: MASTER-SPECIFICATION.md §29.1. */
export type EvalCategory =
  | 'onboarding'
  | 'commands'
  | 'ranks'
  | 'permissions'
  | 'economy'
  | 'tickets'
  | 'rules'
  | 'plugin-behavior'
  | 'known-bugs'
  | 'player-specific-context'
  | 'github-questions'
  | 'ambiguous-questions'
  | 'escalation'
  | 'privacy'
  | 'stale-facts'
  | 'conflicting-evidence'
  | 'tool-failure'
  | 'prompt-injection';

export const EVAL_CATEGORIES: readonly EvalCategory[] = [
  'onboarding',
  'commands',
  'ranks',
  'permissions',
  'economy',
  'tickets',
  'rules',
  'plugin-behavior',
  'known-bugs',
  'player-specific-context',
  'github-questions',
  'ambiguous-questions',
  'escalation',
  'privacy',
  'stale-facts',
  'conflicting-evidence',
  'tool-failure',
  'prompt-injection',
];

/** Visibility classes mirror @enthusia/contracts Visibility (kept local so this
 *  package has no runtime dependency on the contracts dist build). */
export type VisibilityClass =
  | 'PUBLIC'
  | 'PLAYER_SELF'
  | 'STAFF'
  | 'MANAGEMENT'
  | 'SYSTEM_INTERNAL'
  | 'SECRET_DENY';

/** Sensitivity ordering: lower = less sensitive (mirrors contracts §48.1). */
const VISIBILITY_RANK: Record<VisibilityClass, number> = {
  PUBLIC: 0,
  PLAYER_SELF: 1,
  STAFF: 2,
  MANAGEMENT: 3,
  SYSTEM_INTERNAL: 4,
  SECRET_DENY: 5,
};

export function visibilityRank(v: VisibilityClass): number {
  return VISIBILITY_RANK[v];
}

/**
 * True when content at `itemVisibility` may be disclosed under `ceiling`.
 * SECRET_DENY is never disclosable. PLAYER_SELF additionally requires the
 * requester to be the subject player or authorized staff.
 */
export function canDisclose(
  itemVisibility: VisibilityClass,
  ceiling: VisibilityClass,
  opts: { isSubject?: boolean; isStaff?: boolean } = {},
): boolean {
  if (itemVisibility === 'SECRET_DENY') return false;
  if (visibilityRank(itemVisibility) > visibilityRank(ceiling)) return false;
  if (itemVisibility === 'PLAYER_SELF') {
    return opts.isSubject === true || opts.isStaff === true;
  }
  return true;
}

export type EscalationTarget = 'none' | 'openai' | 'staff';

/** A single tool invocation observed in the SUT's response trace. */
export interface ToolCallTrace {
  tool: string;
  args?: Record<string, unknown>;
  durationMs?: number;
  error?: string;
}

/** Context handed to the system under test alongside the question. */
export interface EvalContext {
  /** Maximum visibility the requester may see. */
  requesterVisibility: VisibilityClass;
  /** Requester is authorized staff. */
  isStaff?: boolean;
  /** Requester is the subject player of the question (PLAYER_SELF checks). */
  isSubject?: boolean;
  /** Opaque requester identity (mock use only — never a real credential). */
  requesterId?: string;
  /**
   * Mutable source snapshot. Stale-truth scenarios mutate this between runs
   * to simulate authoritative source updates (A -> B).
   */
  sources?: Record<string, unknown>;
  /** ISO 8601 evaluation clock. */
  nowIso?: string;
}

/** What the system under test must return for each question. */
export interface EvalResponse {
  answer: string;
  /** Source locators the system claims to have used. */
  sourcesUsed?: string[];
  /** Tool calls the system made while answering. */
  toolCalls?: ToolCallTrace[];
  /** Where the system escalated, if at all. */
  escalated?: EscalationTarget;
  latencyMs?: number;
  tokens?: number;
  costUsd?: number;
  /**
   * Visibility classes of content the system disclosed to the requester.
   * Evaluators use this (and the answer text) for visibility assertions.
   */
  disclosedVisibility?: VisibilityClass[];
}

/**
 * The system-under-test interface. Mock systems implement it now; the real
 * agent system implements it later. Nothing else about the SUT is assumed.
 */
export type SystemUnderTest = (
  question: string,
  context: EvalContext,
) => Promise<EvalResponse>;

/** Assertions the harness can check against an EvalResponse. */
export type Assertion =
  | { type: 'contains'; value: string; caseSensitive?: boolean; message?: string }
  | { type: 'notContains'; value: string; caseSensitive?: boolean; message?: string }
  | { type: 'matches'; pattern: string; message?: string }
  | { type: 'notMatches'; pattern: string; message?: string }
  | { type: 'answerEquals'; value: string; message?: string }
  | { type: 'answered'; message?: string }
  | { type: 'escalatedTo'; target: EscalationTarget; message?: string }
  | { type: 'toolCalled'; tool: string; maxCalls?: number; message?: string }
  | { type: 'toolNotCalled'; tool: string; message?: string }
  | { type: 'sourceUsed'; source: string; message?: string }
  | {
      type: 'noDisclosureAbove';
      ceiling: VisibilityClass;
      isStaff?: boolean;
      isSubject?: boolean;
      /** Strings that must never appear in the answer text. */
      forbidden?: string[];
      message?: string;
    };

/** A single golden evaluation case. */
export interface EvalCase {
  /** Stable unique id, e.g. 'privacy-003'. */
  id: string;
  category: EvalCategory;
  title: string;
  question: string;
  /** Context overrides merged over the run's default context. */
  context?: Partial<EvalContext>;
  assertions: Assertion[];
  tags?: string[];
  /** True once owner/staff reviewed and froze this case (spec §7, §29.1). */
  ownerReviewed?: boolean;
}

/** Result of evaluating one assertion. */
export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  detail: string;
}

/** Result of running one case. */
export interface CaseResult {
  caseId: string;
  category: EvalCategory;
  title: string;
  passed: boolean;
  timedOut: boolean;
  latencyMs: number;
  assertions: AssertionResult[];
  error?: string;
}

/** Harness options. */
export interface RunOptions {
  /** Per-case timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Default EvalContext merged under per-case overrides. */
  defaultContext?: Partial<EvalContext>;
  /** Called after each case completes (streaming progress). */
  onCase?: (result: CaseResult) => void;
}
