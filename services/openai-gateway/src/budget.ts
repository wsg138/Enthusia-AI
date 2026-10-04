/**
 * @enthusia/openai-gateway — cost tracking and budget enforcement (W13).
 *
 * Spec: MASTER-SPECIFICATION.md §37 (external API cost controls):
 * - maximum escalation calls per request (enforced in escalation-policy.ts);
 * - per-request and per-day spend caps, enforced BEFORE the call is made;
 * - per-day budget visibility via summary();
 * - every call logs tokens used and estimated cost.
 *
 * Costs are estimates from the operator-maintained price table
 * (models.ts); they are not OpenAI invoices.
 */
import {
  FALLBACK_MODEL_PRICE,
  priceForModel,
  type ModelPrice,
} from './models.js';

/** Budget caps, in USD. */
export interface BudgetLimits {
  maxUsdPerRequest: number;
  maxUsdPerDay: number;
  /** Also enforced; duplicated here so the tracker can report it. */
  maxEscalationsPerRequest: number;
}

export type BudgetLimitKind = 'per-request' | 'per-day';

/** Thrown BEFORE any API call when a cap would be breached. */
export class BudgetExceededError extends Error {
  readonly limit: BudgetLimitKind;
  readonly spentUsd: number;
  readonly capUsd: number;

  constructor(limit: BudgetLimitKind, spentUsd: number, capUsd: number) {
    super(
      `OpenAI budget exceeded (${limit}): already spent $${spentUsd.toFixed(4)} ` +
        `of $${capUsd.toFixed(4)} cap`,
    );
    this.name = 'BudgetExceededError';
    this.limit = limit;
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

/** One completed escalation call, for the usage log. */
export interface UsageRecord {
  at: string;
  traceId: string;
  packetRef: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}

export interface SpendSummary {
  /** UTC day (YYYY-MM-DD) this summary covers. */
  day: string;
  daySpendUsd: number;
  dayCalls: number;
  totalSpendUsd: number;
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

/**
 * In-memory cost tracker. Day boundaries are UTC. Inject `now` for tests.
 * For durable accounting across restarts, persist summary()/records via the
 * caller's storage (the gateway does not choose a store for you).
 */
export class CostTracker {
  private readonly records: UsageRecord[] = [];

  constructor(
    private readonly limits: BudgetLimits,
    private readonly prices: Record<string, ModelPrice>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  estimateCostUsd(
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): number {
    const price = priceForModel(model, this.prices);
    return (
      (promptTokens / 1_000_000) * price.inputPerMillionUsd +
      (completionTokens / 1_000_000) * price.outputPerMillionUsd
    );
  }

  fallbackPrice(): ModelPrice {
    return FALLBACK_MODEL_PRICE;
  }

  dayKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  spendForDay(day: string): number {
    return this.records
      .filter((r) => r.at.slice(0, 10) === day)
      .reduce((total, r) => total + r.estimatedCostUsd, 0);
  }

  spendForRequest(traceId: string): number {
    return this.records
      .filter((r) => r.traceId === traceId)
      .reduce((total, r) => total + r.estimatedCostUsd, 0);
  }

  callsForRequest(traceId: string): number {
    return this.records.filter((r) => r.traceId === traceId).length;
  }

  /**
   * Pre-call guard: throws BudgetExceededError when the estimated call
   * would breach the per-request or per-day cap. Call BEFORE any API call.
   */
  checkBudget(
    traceId: string,
    model: string,
    estimatedPromptTokens: number,
    estimatedCompletionTokens: number,
  ): void {
    const estimated = this.estimateCostUsd(
      model,
      estimatedPromptTokens,
      estimatedCompletionTokens,
    );

    const requestSpent = this.spendForRequest(traceId);
    if (requestSpent + estimated > this.limits.maxUsdPerRequest) {
      throw new BudgetExceededError(
        'per-request',
        requestSpent,
        this.limits.maxUsdPerRequest,
      );
    }

    const day = this.dayKey(this.now());
    const daySpent = this.spendForDay(day);
    if (daySpent + estimated > this.limits.maxUsdPerDay) {
      throw new BudgetExceededError('per-day', daySpent, this.limits.maxUsdPerDay);
    }
  }

  /** Log a completed call: tokens used and estimated cost. */
  recordUsage(input: {
    traceId: string;
    packetRef: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
  }): UsageRecord {
    const record: UsageRecord = {
      at: this.now().toISOString(),
      traceId: input.traceId,
      packetRef: input.packetRef,
      model: input.model,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      estimatedCostUsd: this.estimateCostUsd(
        input.model,
        input.promptTokens,
        input.completionTokens,
      ),
    };
    this.records.push(record);
    return record;
  }

  /** Per-day budget visibility (§37). */
  summary(): SpendSummary {
    const day = this.dayKey(this.now());
    const dayRecords = this.records.filter((r) => r.at.slice(0, 10) === day);
    return {
      day,
      daySpendUsd: dayRecords.reduce((t, r) => t + r.estimatedCostUsd, 0),
      dayCalls: dayRecords.length,
      totalSpendUsd: this.records.reduce((t, r) => t + r.estimatedCostUsd, 0),
      totalCalls: this.records.length,
      totalPromptTokens: this.records.reduce((t, r) => t + r.promptTokens, 0),
      totalCompletionTokens: this.records.reduce(
        (t, r) => t + r.completionTokens,
        0,
      ),
    };
  }

  /** Copy of the usage log (oldest first). */
  usageLog(): UsageRecord[] {
    return [...this.records];
  }
}
