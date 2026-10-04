/**
 * @enthusia/moderation-adapter — circuit breaker tests (W15).
 *
 * Acceptance: "test circuit breaker (moderation down → support continues)".
 * The breaker must open after repeated failures, short-circuit without
 * network I/O while open, allow a half-open probe after cooldown, and
 * close or re-open based on the probe outcome.
 */
import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../src/circuit-breaker.js';

function makeBreaker(overrides: { failureThreshold?: number; cooldownMs?: number } = {}) {
  return new CircuitBreaker({ failureThreshold: 2, cooldownMs: 50, ...overrides });
}

const fail = () => Promise.reject(new Error('moderation down'));
const ok = () => Promise.resolve('context');

describe('CircuitBreaker', () => {
  it('starts closed and passes calls through', async () => {
    const breaker = makeBreaker();
    expect(breaker.currentState).toBe('closed');
    await expect(breaker.execute(ok)).resolves.toBe('context');
    expect(breaker.stats().totalCalls).toBe(1);
  });

  it('validates options at construction', () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0 })).toThrow();
    expect(() => new CircuitBreaker({ cooldownMs: -1 })).toThrow();
  });

  it('opens after failureThreshold consecutive failures', async () => {
    const breaker = makeBreaker({ failureThreshold: 3 });
    await expect(breaker.execute(fail)).rejects.toThrow('moderation down');
    await expect(breaker.execute(fail)).rejects.toThrow('moderation down');
    expect(breaker.currentState).toBe('closed');
    await expect(breaker.execute(fail)).rejects.toThrow('moderation down');
    expect(breaker.currentState).toBe('open');
    expect(breaker.stats().openedAtMs).not.toBeNull();
  });

  it('resets the failure count on success', async () => {
    const breaker = makeBreaker({ failureThreshold: 2 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    await expect(breaker.execute(ok)).resolves.toBe('context');
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.currentState).toBe('closed');
  });

  it('short-circuits while open without invoking the function', async () => {
    const breaker = makeBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    await expect(breaker.execute(fail)).rejects.toThrow('moderation down');
    expect(breaker.currentState).toBe('open');
    const probe = vi.fn();
    await expect(breaker.execute(probe)).rejects.toThrow('short-circuited');
    expect(probe).not.toHaveBeenCalled();
    await expect(breaker.execute(probe)).rejects.toThrow('short-circuited');
    expect(breaker.stats().totalShortCircuits).toBe(2);
  });

  it('allows a half-open probe after cooldown; success closes the circuit', async () => {
    const breaker = makeBreaker({ failureThreshold: 1, cooldownMs: 30 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.currentState).toBe('open');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(breaker.currentState).toBe('half-open');
    await expect(breaker.execute(ok)).resolves.toBe('context');
    expect(breaker.currentState).toBe('closed');
    // After closing, traffic flows again.
    await expect(breaker.execute(ok)).resolves.toBe('context');
  });

  it('re-opens when the half-open probe fails', async () => {
    const breaker = makeBreaker({ failureThreshold: 1, cooldownMs: 30 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(breaker.currentState).toBe('half-open');
    await expect(breaker.execute(fail)).rejects.toThrow('moderation down');
    expect(breaker.currentState).toBe('open');
    expect(breaker.stats().totalFailures).toBe(2);
  });

  it('reset() forces the circuit closed (operator/test recovery)', async () => {
    const breaker = makeBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.currentState).toBe('open');
    breaker.reset();
    expect(breaker.currentState).toBe('closed');
    await expect(breaker.execute(ok)).resolves.toBe('context');
  });

  it('tracks totals for observability (§36)', async () => {
    const breaker = makeBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    const probe = vi.fn();
    await expect(breaker.execute(probe)).rejects.toThrow('short-circuited');
    const stats = breaker.stats();
    expect(stats.totalCalls).toBe(1);
    expect(stats.totalFailures).toBe(1);
    expect(stats.totalShortCircuits).toBe(1);
    expect(stats.lastFailureAtMs).not.toBeNull();
  });
});
