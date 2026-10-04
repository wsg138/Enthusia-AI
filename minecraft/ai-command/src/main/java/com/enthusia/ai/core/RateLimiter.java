package com.enthusia.ai.core;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;

/**
 * Per-player token-bucket rate limiter.
 *
 * <p>Each player gets a bucket holding {@code maxPerMinute} tokens that
 * refills continuously at {@code maxPerMinute} tokens per minute. One token
 * is consumed per {@code /ai} question. This bounds gateway load per player
 * (spec sections 18.4, 19) without punishing bursty-but-rare usage.
 *
 * <p>Thread-safe; safe to call from async gateway callbacks.
 */
public final class RateLimiter {

    private final int maxPerMinute;
    private final long refillIntervalNanos;
    private final LongSupplier nanoTime;
    private final Map<UUID, Bucket> buckets = new HashMap<>();

    public RateLimiter(int maxPerMinute) {
        this(maxPerMinute, System::nanoTime);
    }

    /** Constructor with injectable clock (tests). */
    RateLimiter(int maxPerMinute, LongSupplier nanoTime) {
        if (maxPerMinute < 1) {
            throw new IllegalArgumentException("maxPerMinute must be >= 1");
        }
        this.maxPerMinute = maxPerMinute;
        this.refillIntervalNanos = 60_000_000_000L / maxPerMinute;
        this.nanoTime = nanoTime;
    }

    /**
     * Try to consume one token for the player.
     *
     * @return true if the request may proceed, false if rate limited
     */
    public synchronized boolean tryAcquire(UUID playerId) {
        Bucket bucket = bucketFor(playerId);
        refill(bucket, nanoTime.getAsLong());
        if (bucket.tokens >= 1.0) {
            bucket.tokens -= 1.0;
            return true;
        }
        return false;
    }

    /**
     * How long until the player may ask again. Returns 0 when a token is
     * currently available.
     */
    public synchronized long retryAfterMillis(UUID playerId) {
        Bucket bucket = bucketFor(playerId);
        long now = nanoTime.getAsLong();
        refill(bucket, now);
        if (bucket.tokens >= 1.0) {
            return 0;
        }
        double needed = 1.0 - bucket.tokens;
        return (long) Math.ceil(needed * refillIntervalNanos / 1_000_000.0);
    }

    /** Forget a player's bucket (admin reset, or player rejoin hygiene). */
    public synchronized void clear(UUID playerId) {
        buckets.remove(playerId);
    }

    /** Forget all buckets (config reload). */
    public synchronized void clearAll() {
        buckets.clear();
    }

    public int getMaxPerMinute() {
        return maxPerMinute;
    }

    private Bucket bucketFor(UUID playerId) {
        return buckets.computeIfAbsent(playerId, id -> new Bucket(maxPerMinute, nanoTime.getAsLong()));
    }

    private void refill(Bucket bucket, long now) {
        long elapsed = now - bucket.lastRefillNanos;
        if (elapsed <= 0) {
            return;
        }
        bucket.tokens = Math.min(maxPerMinute, bucket.tokens + (double) elapsed / refillIntervalNanos);
        bucket.lastRefillNanos = now;
    }

    private static final class Bucket {
        double tokens;
        long lastRefillNanos;

        Bucket(double tokens, long lastRefillNanos) {
            this.tokens = tokens;
            this.lastRefillNanos = lastRefillNanos;
        }
    }
}
