/**
 * @enthusia/ai-gateway — in-memory sliding-window rate limiting.
 *
 * Spec: MASTER-SPECIFICATION.md §18.4 (per-user and global rate limits).
 *
 * Two-level policy: a global limiter plus one limiter per rate-limit key
 * (`<surface>:<actorId>`). A request consumes from the global bucket first,
 * then from its per-user bucket; a rejection at either level short-circuits.
 *
 * In-memory is the documented W02 choice; a distributed limiter is future
 * work for multi-instance deployments.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the oldest hit leaves the window (0 when allowed). */
  retryAfterMs: number;
}

/** Single fixed-size sliding window over hit timestamps. */
export class SlidingWindowLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly maxHits: number,
    private readonly windowMs: number,
  ) {}

  /** Number of hits currently inside the window (after pruning). */
  size(nowMs: number = Date.now()): number {
    this.prune(nowMs);
    return this.hits.length;
  }

  check(nowMs: number = Date.now()): RateLimitDecision {
    this.prune(nowMs);
    if (this.hits.length < this.maxHits) {
      this.hits.push(nowMs);
      return { allowed: true, retryAfterMs: 0 };
    }
    const oldest = this.hits[0] ?? nowMs;
    return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - nowMs) };
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.hits.length > 0 && (this.hits[0] ?? Number.POSITIVE_INFINITY) <= cutoff) {
      this.hits.shift();
    }
  }
}

const WINDOW_MS = 60_000;

/**
 * Gateway rate limiter: global + per-key sliding windows.
 *
 * Per-key limiters with no hits inside the window are dropped lazily so the
 * map cannot grow without bound from one-shot actor IDs.
 */
/** Drop per-key limiters with no hits inside the window once the map grows. */
const MAX_TRACKED_KEYS = 10_000;

export class GatewayRateLimiter {
  private readonly global: SlidingWindowLimiter;
  private readonly perKey = new Map<string, SlidingWindowLimiter>();

  constructor(
    private readonly userPerMin: number,
    private readonly globalPerMin: number,
  ) {
    this.global = new SlidingWindowLimiter(globalPerMin, WINDOW_MS);
  }

  check(key: string, nowMs: number = Date.now()): RateLimitDecision {
    const globalDecision = this.global.check(nowMs);
    if (!globalDecision.allowed) {
      return globalDecision;
    }
    let limiter = this.perKey.get(key);
    if (limiter === undefined) {
      if (this.perKey.size >= MAX_TRACKED_KEYS) {
        this.sweep(nowMs);
      }
      limiter = new SlidingWindowLimiter(this.userPerMin, WINDOW_MS);
      this.perKey.set(key, limiter);
    }
    return limiter.check(nowMs);
  }

  private sweep(nowMs: number): void {
    for (const [key, limiter] of this.perKey) {
      if (limiter.size(nowMs) === 0) {
        this.perKey.delete(key);
      }
    }
  }

  /** Number of tracked per-key limiters (observability/tests). */
  trackedKeys(): number {
    return this.perKey.size;
  }
}

/** Convert a rate-limit decision to a `Retry-After` header value (seconds, min 1). */
export function retryAfterSeconds(decision: RateLimitDecision): number {
  return Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
}
