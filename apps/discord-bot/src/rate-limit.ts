/**
 * @enthusia/discord-bot — rate limiting (W06).
 *
 * Master Specification §18.4 requires per-user AND global limits to prevent
 * spam, model monopolization, tool abuse, and accidental external API costs.
 *
 * Token-bucket implementation with lazy refill. The clock is injectable so
 * tests are deterministic.
 */
import type { RateLimitScopeConfig } from './config.js';

/** Result of a rate-limit check. */
export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the next request would be allowed (0 when allowed). */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Token bucket for one scope (e.g. one user, or the global scope).
 * The bucket starts full; each acquisition consumes one token; tokens
 * refill linearly over the window.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(
    private readonly config: RateLimitScopeConfig,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  tryAcquire(key: string): RateLimitDecision {
    const nowMs = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.config.maxRequests, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
    }
    this.refill(bucket, nowMs);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    // Time until one token refills.
    const msPerToken = this.config.windowMs / this.config.maxRequests;
    const retryAfterMs = Math.max(1, Math.ceil(msPerToken - (nowMs - bucket.lastRefillMs)));
    return { allowed: false, retryAfterMs };
  }

  /** Current available tokens for `key` (tests/diagnostics). */
  tokensAvailable(key: string): number {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      return this.config.maxRequests;
    }
    this.refill(bucket, this.now());
    return Math.floor(bucket.tokens);
  }

  private refill(bucket: Bucket, nowMs: number): void {
    const elapsed = nowMs - bucket.lastRefillMs;
    if (elapsed <= 0) {
      return;
    }
    const refillRate = this.config.maxRequests / this.config.windowMs;
    bucket.tokens = Math.min(this.config.maxRequests, bucket.tokens + elapsed * refillRate);
    bucket.lastRefillMs = nowMs;
  }
}

/** Which scope denied a request. */
export type RateLimitScope = 'user' | 'global';

/** Per-user + global policy check used by the bot core. */
export interface RateLimitCheckResult extends RateLimitDecision {
  /** Which scope denied, or null when allowed. */
  deniedBy: RateLimitScope | null;
}

/**
 * Combined Discord rate-limit policy (§18.4): a request must pass BOTH the
 * per-user bucket and the global bucket.
 */
export class DiscordRateLimitPolicy {
  private readonly perUser: TokenBucketRateLimiter;
  private readonly global: TokenBucketRateLimiter;

  constructor(
    perUserConfig: RateLimitScopeConfig,
    globalConfig: RateLimitScopeConfig,
    now: () => number = Date.now,
  ) {
    this.perUser = new TokenBucketRateLimiter(perUserConfig, now);
    this.global = new TokenBucketRateLimiter(globalConfig, now);
  }

  /**
   * Check a request from `userId`. The per-user bucket is checked first so
   * one spammer cannot drain the global budget for everyone else.
   */
  check(userId: string): RateLimitCheckResult {
    const userDecision = this.perUser.tryAcquire(userId);
    if (!userDecision.allowed) {
      return { ...userDecision, deniedBy: 'user' };
    }
    const globalDecision = this.global.tryAcquire('global');
    if (!globalDecision.allowed) {
      return { ...globalDecision, deniedBy: 'global' };
    }
    return { allowed: true, retryAfterMs: 0, deniedBy: null };
  }
}
