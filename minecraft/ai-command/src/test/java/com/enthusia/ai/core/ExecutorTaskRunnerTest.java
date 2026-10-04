package com.enthusia.ai.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class ExecutorTaskRunnerTest {

    @Test
    void closeInterruptsActiveWorkAndFencesFurtherDispatch() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch interrupted = new CountDownLatch(1);
        AtomicInteger afterClose = new AtomicInteger();
        ExecutorTaskRunner runner = new ExecutorTaskRunner(1, Runnable::run);

        runner.runAsync(() -> {
            started.countDown();
            try {
                Thread.sleep(Duration.ofMinutes(1));
            } catch (InterruptedException ex) {
                interrupted.countDown();
                Thread.currentThread().interrupt();
            }
        });

        assertTrue(started.await(2, TimeUnit.SECONDS));
        runner.close();
        assertTrue(interrupted.await(2, TimeUnit.SECONDS));

        runner.runAsync(afterClose::incrementAndGet);
        runner.runSync(afterClose::incrementAndGet);
        assertEquals(0, afterClose.get());
    }
}
