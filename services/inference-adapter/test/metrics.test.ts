import { describe, expect, it } from 'vitest';
import { InferenceMetrics, emptyMetricsSnapshot } from '../src/index.js';

describe('InferenceMetrics', () => {
  it('starts empty', () => {
    const metrics = new InferenceMetrics();
    expect(metrics.snapshot()).toEqual(emptyMetricsSnapshot());
  });

  it('tracks a full successful request lifecycle', () => {
    const metrics = new InferenceMetrics();
    metrics.requestStarted();
    metrics.queueWaitStarted();
    expect(metrics.snapshot().queueDepth).toBe(1);
    metrics.queueWaitFinished();

    let snap = metrics.snapshot();
    expect(snap.queueDepth).toBe(0);
    expect(snap.activeRequests).toBe(1);

    metrics.tokensRecorded(12, 7);
    metrics.requestFinished(250, true);

    snap = metrics.snapshot();
    expect(snap.totalRequests).toBe(1);
    expect(snap.successfulRequests).toBe(1);
    expect(snap.failedRequests).toBe(0);
    expect(snap.promptTokens).toBe(12);
    expect(snap.completionTokens).toBe(7);
    expect(snap.latency.count).toBe(1);
    expect(snap.latency.sumMs).toBe(250);
    expect(snap.latency.minMs).toBe(250);
    expect(snap.latency.maxMs).toBe(250);
    expect(snap.latency.avgMs).toBe(250);
    expect(snap.activeRequests).toBe(0);
  });

  it('tracks failures and retries', () => {
    const metrics = new InferenceMetrics();
    metrics.requestStarted();
    metrics.queueWaitStarted();
    metrics.queueWaitFinished();
    metrics.retryIssued();
    metrics.retryIssued();
    metrics.requestFinished(900, false);

    const snap = metrics.snapshot();
    expect(snap.failedRequests).toBe(1);
    expect(snap.successfulRequests).toBe(0);
    expect(snap.retriedAttempts).toBe(2);
  });

  it('decrements queue depth when a queued waiter aborts', () => {
    const metrics = new InferenceMetrics();
    metrics.queueWaitStarted();
    metrics.queueWaitStarted();
    metrics.queueWaitAborted();
    expect(metrics.snapshot().queueDepth).toBe(1);
  });

  it('resets to empty', () => {
    const metrics = new InferenceMetrics();
    metrics.requestStarted();
    metrics.queueWaitStarted();
    metrics.queueWaitFinished();
    metrics.tokensRecorded(5, 5);
    metrics.requestFinished(100, true);
    metrics.reset();
    expect(metrics.snapshot()).toEqual(emptyMetricsSnapshot());
  });
});
