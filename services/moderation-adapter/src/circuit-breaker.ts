/**
 * Circuit breaker for moderation-service calls (W15).
 *
 * Design: the adapter is fire-and-forget context enrichment. If the
 * moderation service is down, support continues normally. The breaker
 * guarantees that a downed moderation service costs the support path zero
 * blocking time after the first few failures: once open, calls
 * short-circuit locally without touching the network.
 *
 * States:
 * - closed: calls flow; consecutive failures are counted.
 * - open: calls are rejected immediately; no network I/O. After
 *   `cooldownMs` a single trial is allowed (half-open).
 * - half-open: one probe call is allowed through. Success closes the
 *   circuit; failure re-opens it.
 */

import type { CircuitState } from './types.js';

/** Tunables for the circuit breaker. All values validated at construction. */
export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit (>= 1). Default 3. */
  failureThreshold?: number;
  /** Cooldown before a half-open probe (>= 0 ms). Default 30_000. */
  cooldownMs?: number;
  /** Consecutive half-open successes needed to close (>= 1). Default 1. */
  halfOpenSuccessThreshold?: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalCalls: number;
  totalFailures: number;
  totalShortCircuits: number;
  openedAtMs: number | null;
  lastFailureAtMs: number | null;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenSuccessThreshold: number;

  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAtMs: number | null = null;
  private lastFailureAtMs: number | null = null;
  private totalCalls = 0;
  private totalFailures = 0;
  private totalShortCircuits = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    const failureThreshold = options.failureThreshold ?? 3;
    const cooldownMs = options.cooldownMs ?? 30_000;
    const halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 1;
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new Error('CircuitBreaker: failureThreshold must be an integer >= 1');
    }
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new Error('CircuitBreaker: cooldownMs must be a finite number >= 0');
    }
    if (!Number.isInteger(halfOpenSuccessThreshold) || halfOpenSuccessThreshold < 1) {
      throw new Error('CircuitBreaker: halfOpenSuccessThreshold must be an integer >= 1');
    }
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.halfOpenSuccessThreshold = halfOpenSuccessThreshold;
  }

  get currentState(): CircuitState {
    if (this.state === 'open' && this.openedAtMs !== null) {
      return Date.now() - this.openedAtMs >= this.cooldownMs ? 'half-open' : 'open';
    }
    return this.state;
  }

  /**
   * Run `fn` through the breaker. Returns the result on success.
   * Throws the underlying error on failure (callers decide whether to
   * swallow it — the adapter does). Throws a short-circuit error
   * without invoking `fn` when the circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const effective = this.currentState;
    if (effective === 'open') {
      this.totalShortCircuits += 1;
      throw new Error('CircuitBreaker: circuit open — moderation call short-circuited');
    }
    if (effective === 'half-open') {
      this.state = 'half-open';
    }
    this.totalCalls += 1;
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.halfOpenSuccessThreshold) {
        this.state = 'closed';
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
        this.openedAtMs = null;
      }
    } else {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
    }
  }

  private onFailure(): void {
    this.totalFailures += 1;
    this.lastFailureAtMs = Date.now();
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAtMs = Date.now();
      return;
    }
    if (this.state === 'closed' && this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAtMs = Date.now();
    }
  }

  /** Force-reset (tests, operator recovery). Does not clear totals. */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAtMs = null;
  }

  stats(): CircuitBreakerStats {
    return {
      state: this.currentState,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      totalShortCircuits: this.totalShortCircuits,
      openedAtMs: this.openedAtMs,
      lastFailureAtMs: this.lastFailureAtMs,
    };
  }
}
