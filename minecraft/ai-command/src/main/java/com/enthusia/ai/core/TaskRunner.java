package com.enthusia.ai.core;

/**
 * Abstraction over the server scheduler so the command executor can be unit
 * tested without Bukkit.
 *
 * <p>Gateway calls must never run on the main thread (spec section 19), and
 * chat output must be delivered back on the main thread.
 */
public interface TaskRunner extends AutoCloseable {

    /** Run a task off the main thread (network I/O goes here). */
    void runAsync(Runnable task);

    /** Run a task on the server main thread (sending chat goes here). */
    void runSync(Runnable task);

    /** Cancel queued work and interrupt active work during plugin disable. */
    @Override
    default void close() {
        // Test fakes and synchronous runners have nothing to release.
    }
}
