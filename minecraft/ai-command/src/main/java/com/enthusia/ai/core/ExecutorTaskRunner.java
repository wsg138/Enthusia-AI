package com.enthusia.ai.core;

import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Bounded lifecycle owner for off-main-thread gateway work.
 *
 * <p>Only network work is submitted here. Bukkit/Paper calls remain behind the
 * supplied sync dispatcher, which the plugin binds to the server scheduler.
 */
public final class ExecutorTaskRunner implements TaskRunner {

    private final ExecutorService executor;
    private final Consumer<Runnable> syncDispatcher;
    private final AtomicBoolean closed = new AtomicBoolean();

    public ExecutorTaskRunner(int threads, Consumer<Runnable> syncDispatcher) {
        if (threads < 1 || threads > 8) {
            throw new IllegalArgumentException("threads must be between 1 and 8");
        }
        this.syncDispatcher = Objects.requireNonNull(syncDispatcher, "syncDispatcher");
        this.executor = Executors.newFixedThreadPool(threads, daemonThreadFactory());
    }

    @Override
    public void runAsync(Runnable task) {
        Objects.requireNonNull(task, "task");
        if (closed.get()) {
            return;
        }
        try {
            executor.execute(() -> {
                if (!closed.get()) {
                    task.run();
                }
            });
        } catch (RejectedExecutionException ex) {
            if (!closed.get()) {
                throw ex;
            }
        }
    }

    @Override
    public void runSync(Runnable task) {
        Objects.requireNonNull(task, "task");
        if (closed.get()) {
            return;
        }
        syncDispatcher.accept(() -> {
            if (!closed.get()) {
                task.run();
            }
        });
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) {
            executor.shutdownNow();
        }
    }

    private static ThreadFactory daemonThreadFactory() {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task, "enthusia-ai-http-" + sequence.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }
}
