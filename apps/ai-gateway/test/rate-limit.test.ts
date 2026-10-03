import { describe, expect, it } from 'vitest';
import { GatewayRateLimiter, SlidingWindowLimiter, retryAfterSeconds } from '../src/rate-limit.js';

describe('SlidingWindowLimiter', () => {
  it('allows up to maxHits inside the window, then denies', () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    const now = 1_000_000;
    expect(limiter.check(now).allowed).toBe(true);
    expect(limiter.check(now).allowed).toBe(true);
    expect(limiter.check(now).allowed).toBe(true);
    const denied = limiter.check(now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('slides: hits older than the window stop counting', () => {
    const limiter = new SlidingWindowLimiter(2, 60_000);
    const t0 = 1_000_000;
    expect(limiter.check(t0).allowed).toBe(true);
    expect(limiter.check(t0).allowed).toBe(true);
    expect(limiter.check(t0).allowed).toBe(false);
    // 61s later the window is empty again.
    expect(limiter.check(t0 + 61_000).allowed).toBe(true);
    expect(limiter.check(t0 + 61_000).allowed).toBe(true);
    expect(limiter.check(t0 + 61_000).allowed).toBe(false);
  });

  it('retryAfterMs reflects the oldest hit leaving the window', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    const t0 = 1_000_000;
    limiter.check(t0);
    const denied = limiter.check(t0 + 10_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(50_000);
  });
});

describe('GatewayRateLimiter', () => {
  it('enforces per-user limits independently per key', () => {
    const limiter = new GatewayRateLimiter(2, 100);
    const now = 2_000_000;
    expect(limiter.check('discord:alice', now).allowed).toBe(true);
    expect(limiter.check('discord:alice', now).allowed).toBe(true);
    expect(limiter.check('discord:alice', now).allowed).toBe(false);
    // A different actor is unaffected.
    expect(limiter.check('discord:bob', now).allowed).toBe(true);
    // Same actor id on another surface is a different key.
    expect(limiter.check('minecraft:alice', now).allowed).toBe(true);
  });

  it('global limit short-circuits before per-user accounting', () => {
    const limiter = new GatewayRateLimiter(100, 2);
    const now = 3_000_000;
    expect(limiter.check('discord:alice', now).allowed).toBe(true);
    expect(limiter.check('discord:bob', now).allowed).toBe(true);
    const denied = limiter.check('discord:carol', now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('recovers after the window passes', () => {
    const limiter = new GatewayRateLimiter(1, 10);
    const t0 = 4_000_000;
    expect(limiter.check('discord:alice', t0).allowed).toBe(true);
    expect(limiter.check('discord:alice', t0).allowed).toBe(false);
    expect(limiter.check('discord:alice', t0 + 61_000).allowed).toBe(true);
  });

  it('reclaims stale per-key limiters once the cap is hit', () => {
    const limiter = new GatewayRateLimiter(5, 1_000_000);
    const t0 = 5_000_000;
    for (let i = 0; i < 10_000; i++) {
      limiter.check(`discord:user-${i}`, t0);
    }
    expect(limiter.trackedKeys()).toBe(10_000);
    // The window passes; the next insert triggers a sweep that drops the
    // stale one-shot keys instead of growing the map.
    limiter.check('discord:new-user', t0 + 61_000);
    expect(limiter.trackedKeys()).toBe(1);
  });
});

describe('retryAfterSeconds', () => {
  it('rounds up to whole seconds with a minimum of 1', () => {
    expect(retryAfterSeconds({ allowed: false, retryAfterMs: 1 })).toBe(1);
    expect(retryAfterSeconds({ allowed: false, retryAfterMs: 1000 })).toBe(1);
    expect(retryAfterSeconds({ allowed: false, retryAfterMs: 1001 })).toBe(2);
    expect(retryAfterSeconds({ allowed: false, retryAfterMs: 59_000 })).toBe(59);
  });
});
