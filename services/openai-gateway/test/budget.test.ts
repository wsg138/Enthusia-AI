import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  CostTracker,
  type BudgetLimits,
} from '../src/budget.js';
import { DEFAULT_MODEL_PRICES } from '../src/models.js';

const LIMITS: BudgetLimits = {
  maxUsdPerRequest: 2,
  maxUsdPerDay: 10,
  maxEscalationsPerRequest: 3,
};

function tracker(limits: BudgetLimits = LIMITS): CostTracker {
  return new CostTracker(limits, DEFAULT_MODEL_PRICES);
}

describe('CostTracker.estimateCostUsd', () => {
  it('prices input and output tokens from the model table', () => {
    const t = tracker();
    // gpt-5.2: $2.50 / $10 per 1M
    expect(t.estimateCostUsd('gpt-5.2', 1_000_000, 1_000_000)).toBeCloseTo(
      12.5,
      6,
    );
    expect(t.estimateCostUsd('gpt-5.2', 400, 200)).toBeCloseTo(
      (400 / 1e6) * 2.5 + (200 / 1e6) * 10,
      9,
    );
  });

  it('falls back to the conservative price for unknown models', () => {
    const t = tracker();
    expect(t.estimateCostUsd('mystery-model', 1_000_000, 0)).toBeCloseTo(5, 6);
  });
});

describe('CostTracker.checkBudget', () => {
  it('passes when the estimate fits both caps', () => {
    expect(() => tracker().checkBudget('t1', 'gpt-5.2', 100, 100)).not.toThrow();
  });

  it('blocks a call that would breach the per-request cap', () => {
    const t = tracker();
    t.recordUsage({
      traceId: 't1',
      packetRef: 'packet:t1',
      model: 'gpt-5.2',
      promptTokens: 100,
      completionTokens: 100,
    });
    // 1M+1M tokens ≈ $12.50, over the $2 request cap.
    try {
      t.checkBudget('t1', 'gpt-5.2', 1_000_000, 1_000_000);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect((error as BudgetExceededError).limit).toBe('per-request');
    }
  });

  it('blocks a call that would breach the per-day cap', () => {
    const t = tracker({ ...LIMITS, maxUsdPerDay: 0.0001 });
    try {
      t.checkBudget('t1', 'gpt-5.2', 100, 100);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as BudgetExceededError).limit).toBe('per-day');
    }
  });

  it('accumulates spend across calls for the same request', () => {
    const t = tracker();
    for (let i = 0; i < 3; i++) {
      t.recordUsage({
        traceId: 't1',
        packetRef: 'packet:t1',
        model: 'gpt-5.2',
        promptTokens: 100_000,
        completionTokens: 100_000,
      });
    }
    // 3 × $1.25 = $3.75 > $2 cap → the next estimate breaches even at ~0.
    expect(t.spendForRequest('t1')).toBeCloseTo(3.75, 6);
    expect(() => t.checkBudget('t1', 'gpt-5.2', 10, 10)).toThrowError(
      BudgetExceededError,
    );
  });
});

describe('CostTracker.summary', () => {
  it('reports per-day visibility: spend, calls, tokens', () => {
    let now = new Date('2026-10-03T10:00:00Z');
    const t = new CostTracker(LIMITS, DEFAULT_MODEL_PRICES, () => now);
    t.recordUsage({
      traceId: 't1',
      packetRef: 'packet:t1',
      model: 'gpt-5.2',
      promptTokens: 1000,
      completionTokens: 500,
    });
    const summary = t.summary();
    expect(summary.day).toBe('2026-10-03');
    expect(summary.dayCalls).toBe(1);
    expect(summary.totalCalls).toBe(1);
    expect(summary.totalPromptTokens).toBe(1000);
    expect(summary.totalCompletionTokens).toBe(500);
    expect(summary.daySpendUsd).toBeCloseTo(
      t.estimateCostUsd('gpt-5.2', 1000, 500),
      9,
    );

    // Next UTC day resets the daily counters, not the totals.
    now = new Date('2026-10-04T01:00:00Z');
    const next = t.summary();
    expect(next.day).toBe('2026-10-04');
    expect(next.dayCalls).toBe(0);
    expect(next.totalCalls).toBe(1);
  });

  it('exposes the raw usage log for audit', () => {
    const t = tracker();
    const record = t.recordUsage({
      traceId: 't9',
      packetRef: 'packet:t9',
      model: 'gpt-5.2-mini',
      promptTokens: 10,
      completionTokens: 5,
    });
    const log = t.usageLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual(record);
    expect(log[0]?.estimatedCostUsd).toBeGreaterThan(0);
  });
});
