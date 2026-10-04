package com.enthusia.ai.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

class RateLimiterTest {

    private final AtomicLong nowNanos = new AtomicLong(0);
    private final UUID player = UUID.randomUUID();

    private RateLimiter limiter(int perMinute) {
        return new RateLimiter(perMinute, nowNanos::get);
    }

    @Test
    void allowsUpToCapacityThenDenies() {
        RateLimiter limiter = limiter(3);
        assertTrue(limiter.tryAcquire(player));
        assertTrue(limiter.tryAcquire(player));
        assertTrue(limiter.tryAcquire(player));
        assertFalse(limiter.tryAcquire(player));
    }

    @Test
    void bucketsArePerPlayer() {
        RateLimiter limiter = limiter(1);
        UUID other = UUID.randomUUID();
        assertTrue(limiter.tryAcquire(player));
        assertFalse(limiter.tryAcquire(player));
        assertTrue(limiter.tryAcquire(other));
    }

    @Test
    void refillsOverTime() {
        RateLimiter limiter = limiter(2); // one token per 30s
        assertTrue(limiter.tryAcquire(player));
        assertTrue(limiter.tryAcquire(player));
        assertFalse(limiter.tryAcquire(player));

        nowNanos.addAndGet(30_000_000_000L);
        assertTrue(limiter.tryAcquire(player));
        assertFalse(limiter.tryAcquire(player));
    }

    @Test
    void refillNeverExceedsCapacity() {
        RateLimiter limiter = limiter(2);
        nowNanos.addAndGet(3_600_000_000_000L); // an hour later
        assertTrue(limiter.tryAcquire(player));
        assertTrue(limiter.tryAcquire(player));
        assertFalse(limiter.tryAcquire(player));
    }

    @Test
    void retryAfterMillis() {
        RateLimiter limiter = limiter(2); // one token per 30s
        assertEquals(0, limiter.retryAfterMillis(player));
        limiter.tryAcquire(player);
        limiter.tryAcquire(player);
        long wait = limiter.retryAfterMillis(player);
        assertTrue(wait > 0 && wait <= 30_000,
                "expected up to 30s wait, got " + wait);
    }

    @Test
    void clearResetsBucket() {
        RateLimiter limiter = limiter(1);
        assertTrue(limiter.tryAcquire(player));
        assertFalse(limiter.tryAcquire(player));
        limiter.clear(player);
        assertTrue(limiter.tryAcquire(player));
    }

    @Test
    void clearAllResetsEveryone() {
        RateLimiter limiter = limiter(1);
        UUID other = UUID.randomUUID();
        limiter.tryAcquire(player);
        limiter.tryAcquire(other);
        limiter.clearAll();
        assertTrue(limiter.tryAcquire(player));
        assertTrue(limiter.tryAcquire(other));
    }
}
