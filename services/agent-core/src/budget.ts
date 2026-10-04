/**
 * @enthusia/agent-core — tool budgets (W12).
 *
 * Spec: MASTER-SPECIFICATION.md §78 (tool budgets) and §15.3 (bounded
 * curiosity: tool budgets, maximum investigation depth, timeouts).
 *
 * Budgets are enforced deterministically by the orchestrator. The reasoner
 * is told how much budget remains; it cannot grant itself more.
 */
import type { RequestClass } from './types.js';

/** Budget policy for one request class. */
export interface BudgetPolicy {
  requestClass: RequestClass;
  /** Maximum tool executions for the whole request. */
  maxToolCalls: number;
  /** Maximum investigation-loop iterations (rounds of tool calls). */
  maxIterations: number;
  /** Maximum reasoner (model) calls: classify + plan + steps + draft. */
  maxReasonerCalls: number;
  /** Wall-clock cap for the whole investigation, milliseconds. */
  timeoutMs: number;
}

/**
 * Budget policies per request class (§78).
 *
 * - Simple: small retrieval/tool budget — max 3 tool calls.
 * - Investigative: larger bounded budget — max 10 tool calls.
 * - Engineering: gather evidence, then escalate — bounded locally, the
 *   heavy work is delegated to W13 with an investigation packet.
 */
export const BUDGET_POLICIES: Record<RequestClass, BudgetPolicy> = {
  simple: {
    requestClass: 'simple',
    maxToolCalls: 3,
    maxIterations: 3,
    maxReasonerCalls: 8,
    timeoutMs: 30_000,
  },
  investigative: {
    requestClass: 'investigative',
    maxToolCalls: 10,
    maxIterations: 8,
    maxReasonerCalls: 20,
    timeoutMs: 120_000,
  },
  engineering: {
    requestClass: 'engineering',
    maxToolCalls: 8,
    maxIterations: 6,
    maxReasonerCalls: 16,
    timeoutMs: 120_000,
  },
};

/** Per-request-class overrides (e.g. tests, deployments). */
export type BudgetOverrides = Partial<Record<RequestClass, Partial<BudgetPolicy>>>;

/** Resolve the effective policy for a request class, applying overrides. */
export function policyForRequestClass(
  requestClass: RequestClass,
  overrides?: BudgetOverrides,
): BudgetPolicy {
  const base = BUDGET_POLICIES[requestClass];
  const override = overrides?.[requestClass];
  return override ? { ...base, ...override, requestClass } : { ...base };
}

/**
 * Mutable per-request budget tracker. The investigation loop consults this
 * before every reasoner call, tool call, and iteration; when any dimension
 * is exhausted the loop terminates deterministically — the loop can never
 * run indefinitely, regardless of what the reasoner proposes.
 */
export class BudgetTracker {
  private toolCallsUsed = 0;
  private iterationsUsed = 0;
  private reasonerCallsUsed = 0;

  constructor(private readonly policy: BudgetPolicy) {}

  getPolicy(): BudgetPolicy {
    return this.policy;
  }

  getToolCallsUsed(): number {
    return this.toolCallsUsed;
  }

  getIterationsUsed(): number {
    return this.iterationsUsed;
  }

  getReasonerCallsUsed(): number {
    return this.reasonerCallsUsed;
  }

  canCallTools(count = 1): boolean {
    return this.toolCallsUsed + count <= this.policy.maxToolCalls;
  }

  canIterate(): boolean {
    return this.iterationsUsed < this.policy.maxIterations;
  }

  canCallReasoner(count = 1): boolean {
    return this.reasonerCallsUsed + count <= this.policy.maxReasonerCalls;
  }

  toolCallsRemaining(): number {
    return Math.max(0, this.policy.maxToolCalls - this.toolCallsUsed);
  }

  iterationsRemaining(): number {
    return Math.max(0, this.policy.maxIterations - this.iterationsUsed);
  }

  reasonerCallsRemaining(): number {
    return Math.max(0, this.policy.maxReasonerCalls - this.reasonerCallsUsed);
  }

  /** True when any budget dimension is exhausted. */
  exhausted(): boolean {
    return (
      !this.canCallTools() || !this.canIterate() || !this.canCallReasoner()
    );
  }

  recordToolCalls(count = 1): void {
    this.toolCallsUsed += count;
  }

  recordIteration(): void {
    this.iterationsUsed += 1;
  }

  recordReasonerCalls(count = 1): void {
    this.reasonerCallsUsed += count;
  }
}
