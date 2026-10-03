/**
 * Tests for rate limiting (§18.4): per-user and global token buckets with a
 * fake clock for determinism.
 */
import { describe, expect, it } from 'vitest';

import { DiscordRateLimitPolicy, TokenBucketRateLimiter } from '../src/rate-limit.js';

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('TokenBucketRateLimiter', () => {
  it('allows up to the max, then denies with a retry hint', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ maxRequests: 3, windowMs: 60_000 }, clock.now);
    expect(limiter.tryAcquire('u').allowed).toBe(true);
    expect(limiter.tryAcquire('u').allowed).toBe(true);
    expect(limiter.tryAcquire('u').allowed).toBe(true);
    const denied = limiter.tryAcquire('u');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills after the window passes', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 60_000 }, clock.now);
    expect(limiter.tryAcquire('u').allowed).toBe(true);
    expect(limiter.tryAcquire('u').allowed).toBe(false);
    clock.advance(60_000);
    expect(limiter.tryAcquire('u').allowed).toBe(true);
  });

  it('isolates buckets per key', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 60_000 }, clock.now);
    expect(limiter.tryAcquire('alice').allowed).toBe(true);
    expect(limiter.tryAcquire('alice').allowed).toBe(false);
    expect(limiter.tryAcquire('bob').allowed).toBe(true);
  });
});

describe('DiscordRateLimitPolicy', () => {
  it('denies by user scope when the per-user budget is exhausted', () => {
    const clock = fakeClock();
    const policy = new DiscordRateLimitPolicy(
      { maxRequests: 1, windowMs: 60_000 },
      { maxRequests: 100, windowMs: 60_000 },
      clock.now,
    );
    expect(policy.check('alice').deniedBy).toBeNull();
    const denied = policy.check('alice');
    expect(denied.allowed).toBe(false);
    expect(denied.deniedBy).toBe('user');
    // Another user is unaffected.
    expect(policy.check('bob').allowed).toBe(true);
  });

  it('denies by global scope when the global budget is exhausted', () => {
    const clock = fakeClock();
    const policy = new DiscordRateLimitPolicy(
      { maxRequests: 100, windowMs: 60_000 },
      { maxRequests: 2, windowMs: 60_000 },
      clock.now,
    );
    expect(policy.check('alice').allowed).toBe(true);
    expect(policy.check('bob').allowed).toBe(true);
    const denied = policy.check('carol');
    expect(denied.allowed).toBe(false);
    expect(denied.deniedBy).toBe('global');
  });

  it('recovers after the window passes', () => {
    const clock = fakeClock();
    const policy = new DiscordRateLimitPolicy(
      { maxRequests: 1, windowMs: 10_000 },
      { maxRequests: 100, windowMs: 10_000 },
      clock.now,
    );
    expect(policy.check('alice').allowed).toBe(true);
    expect(policy.check('alice').allowed).toBe(false);
    clock.advance(10_000);
    expect(policy.check('alice').allowed).toBe(true);
  });
});
