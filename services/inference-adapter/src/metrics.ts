/**
 * @enthusia/inference-adapter — inference metrics.
 *
 * Spec: MASTER-SPECIFICATION.md §36. Tracked: prompt tokens, generation
 * tokens, inference latency, queue depth, active requests, model loaded
 * (surfaced via health), plus request/retry/error counters.
 *
 * This class is synchronization-free and safe to share across requests; the
 * client updates it on every request lifecycle event.
 */

export interface LatencyStats {
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
}

export interface MetricsSnapshot {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  /** Total retry attempts (excludes the first attempt of each request). */
  retriedAttempts: number;
  promptTokens: number;
  completionTokens: number;
  latency: LatencyStats;
  /** Requests currently executing (inside the concurrency gate). */
  activeRequests: number;
  /** Requests waiting for a concurrency slot. */
  queueDepth: number;
}

export function emptyMetricsSnapshot(): MetricsSnapshot {
  return {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    retriedAttempts: 0,
    promptTokens: 0,
    completionTokens: 0,
    latency: { count: 0, sumMs: 0, minMs: 0, maxMs: 0, avgMs: 0 },
    activeRequests: 0,
    queueDepth: 0,
  };
}

export class InferenceMetrics {
  private totalRequests = 0;
  private successfulRequests = 0;
  private failedRequests = 0;
  private retriedAttempts = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private latencyCount = 0;
  private latencySumMs = 0;
  private latencyMinMs = Number.POSITIVE_INFINITY;
  private latencyMaxMs = 0;
  private activeRequests = 0;
  private queueDepth = 0;

  /** A request entered the client (before queueing). */
  requestStarted(): void {
    this.totalRequests += 1;
  }

  /** A request started waiting for a concurrency slot. */
  queueWaitStarted(): void {
    this.queueDepth += 1;
  }

  /** A request acquired a concurrency slot. */
  queueWaitFinished(): void {
    this.queueDepth = Math.max(0, this.queueDepth - 1);
    this.activeRequests += 1;
  }

  /** A request aborted while waiting for a concurrency slot. */
  queueWaitAborted(): void {
    this.queueDepth = Math.max(0, this.queueDepth - 1);
  }

  /** A retry attempt is about to be issued (excludes first attempts). */
  retryIssued(): void {
    this.retriedAttempts += 1;
  }

  /**
   * A request finished.
   *
   * @param latencyMs end-to-end latency of the successful attempt, or of the
   *   final failed attempt when `success` is false.
   */
  requestFinished(latencyMs: number, success: boolean): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.latencyCount += 1;
    this.latencySumMs += latencyMs;
    this.latencyMinMs = Math.min(this.latencyMinMs, latencyMs);
    this.latencyMaxMs = Math.max(this.latencyMaxMs, latencyMs);
    if (success) {
      this.successfulRequests += 1;
    } else {
      this.failedRequests += 1;
    }
  }

  /** Record token usage reported by the server for one request. */
  tokensRecorded(promptTokens: number, completionTokens: number): void {
    this.promptTokens += Math.max(0, Math.floor(promptTokens));
    this.completionTokens += Math.max(0, Math.floor(completionTokens));
  }

  snapshot(): MetricsSnapshot {
    const count = this.latencyCount;
    return {
      totalRequests: this.totalRequests,
      successfulRequests: this.successfulRequests,
      failedRequests: this.failedRequests,
      retriedAttempts: this.retriedAttempts,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      latency: {
        count,
        sumMs: this.latencySumMs,
        minMs: count === 0 ? 0 : this.latencyMinMs,
        maxMs: this.latencyMaxMs,
        avgMs: count === 0 ? 0 : this.latencySumMs / count,
      },
      activeRequests: this.activeRequests,
      queueDepth: this.queueDepth,
    };
  }

  reset(): void {
    this.totalRequests = 0;
    this.successfulRequests = 0;
    this.failedRequests = 0;
    this.retriedAttempts = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.latencyCount = 0;
    this.latencySumMs = 0;
    this.latencyMinMs = Number.POSITIVE_INFINITY;
    this.latencyMaxMs = 0;
    this.activeRequests = 0;
    this.queueDepth = 0;
  }
}
