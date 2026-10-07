/**
 * @enthusia/moderation-adapter — failure isolation tests (W15).
 *
 * Acceptance: "test circuit breaker (moderation down → support continues)".
 *
 * Key design: fire-and-forget enrichment. These tests prove:
 * 1. enrichContext() NEVER throws — moderation down means support gets
 *    { context: null, moderationAvailable: false }, not an exception.
 * 2. A simulated support response completes normally whether or not
 *    moderation answers — support never blocks on moderation health.
 * 3. Once the breaker opens, enrichment is instant and makes no network
 *    calls (zero blocking time, zero load on the failing service).
 * 4. getModerationStatus() and moderationDependencyHealth() report
 *    reachability without depending on the service.
 */
import { describe, expect, it, vi } from 'vitest';
import { ModerationAdapter } from '../src/adapter.js';
import type { SharedIdentityMetadata } from '../src/types.js';
import {
  downApi,
  healthyApi,
  MockModerationApi,
  notReadyHealthBody,
  sampleDecisionBody,
} from './mocks.js';

const IDENTITY: SharedIdentityMetadata = {
  supportSubjectId: 'player-uuid-1234',
  moderationSubjectId: 'canonical-player-42',
};

function makeAdapter(api: MockModerationApi, overrides: { cooldownMs?: number } = {}) {
  return new ModerationAdapter({
    client: {
      baseUrl: 'http://moderation:8080',
      clientId: 'enthusia-support',
      apiKey: 'runtime-test-token',
      fetchFn: api.fetch,
    },
    circuitBreaker: { failureThreshold: 2, cooldownMs: overrides.cooldownMs ?? 50 },
  });
}

/**
 * Stand-in for the support pipeline: builds a response using whatever
 * moderation context is available. This must always resolve.
 */
async function supportRespond(context: unknown): Promise<string> {
  if (context === null) return 'Here is the answer (no moderation history available).';
  return 'Here is the answer (moderation history considered).';
}

describe('failure isolation', () => {
  it('enriches support context when moderation is up', async () => {
    const api = new MockModerationApi({ body: sampleDecisionBody() });
    const adapter = makeAdapter(api);
    const result = await adapter.enrichContext(IDENTITY);
    expect(result.moderationAvailable).toBe(true);
    expect(result.context).not.toBeNull();
    expect(result.context?.subjectId).toBe('player-uuid-1234');
    expect(result.context?.decisions).toHaveLength(2);
    expect(result.context?.stale).toBe(false);
    await expect(supportRespond(result.context)).resolves.toContain('moderation history considered');
  });

  it('moderation down → enrichment resolves with null context instead of throwing', async () => {
    const adapter = makeAdapter(downApi());
    const result = await adapter.enrichContext(IDENTITY, { enrichmentTimeoutMs: 1000 });
    expect(result).toEqual({ context: null, moderationAvailable: false });
    // Support continues normally.
    await expect(supportRespond(result.context)).resolves.toContain('no moderation history available');
  });

  it('support continues during a moderation outage even under load', async () => {
    const adapter = makeAdapter(downApi());
    const responses = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const result = await adapter.enrichContext(IDENTITY);
        return supportRespond(result.context);
      }),
    );
    expect(responses).toHaveLength(5);
    for (const r of responses) expect(r).toContain('no moderation history available');
    expect(adapter.breakerStats().state).toBe('open');
  });

  it('open circuit makes enrichment instant with zero network calls', async () => {
    const api = downApi();
    const adapter = makeAdapter(api, { cooldownMs: 60_000 });
    await adapter.enrichContext(IDENTITY);
    await adapter.enrichContext(IDENTITY);
    expect(adapter.breakerStats().state).toBe('open');
    const callsBefore = api.calls.length;
    const start = Date.now();
    const result = await adapter.enrichContext(IDENTITY);
    const elapsed = Date.now() - start;
    expect(result.moderationAvailable).toBe(false);
    expect(api.calls.length).toBe(callsBefore);
    // Short-circuit: no timeout waiting, well under any network latency.
    expect(elapsed).toBeLessThan(100);
  });

  it('enrichment times out gracefully instead of hanging support (hanging service)', async () => {
    const api = new MockModerationApi({ hang: true });
    const adapter = makeAdapter(api, { cooldownMs: 60_000 });
    const result = await adapter.enrichContext(IDENTITY, { enrichmentTimeoutMs: 120 });
    expect(result.moderationAvailable).toBe(false);
    expect(result.context).toBeNull();
  });

  it('malformed moderation payloads do not break support', async () => {
    const api = new MockModerationApi({ body: { decisions: 'garbage' } });
    const adapter = makeAdapter(api);
    const result = await adapter.enrichContext(IDENTITY);
    expect(result).toEqual({ context: null, moderationAvailable: false });
    await expect(supportRespond(result.context)).resolves.toContain('no moderation history available');
  });

  it('getModerationStatus reports reachable when the service is up', async () => {
    const adapter = makeAdapter(healthyApi());
    await expect(adapter.getModerationStatus()).resolves.toBe('reachable');
    const dep = await adapter.moderationDependencyHealth();
    expect(dep).toMatchObject({ name: 'moderation', status: 'ok' });
  });

  it('getModerationStatus reports degraded when the service is reachable but not ready', async () => {
    const adapter = makeAdapter(
      new MockModerationApi({ status: 503, body: notReadyHealthBody() }),
    );
    await expect(adapter.getModerationStatus()).resolves.toBe('degraded');
    const dep = await adapter.moderationDependencyHealth();
    expect(dep.status).toBe('degraded');
  });

  it('getModerationStatus reports unreachable when the service is down, and circuit-open once the breaker trips', async () => {
    const adapter = makeAdapter(downApi(), { cooldownMs: 60_000 });
    await expect(adapter.getModerationStatus()).resolves.toBe('unreachable');
    await expect(adapter.getModerationStatus()).resolves.toBe('unreachable');
    await expect(adapter.getModerationStatus()).resolves.toBe('circuit-open');
    const dep = await adapter.moderationDependencyHealth();
    expect(dep).toMatchObject({ name: 'moderation', status: 'down' });
  });

  it('recovery: after the service returns, enrichment works again (breaker half-opens)', async () => {
    const api = downApi();
    const adapter = makeAdapter(api, { cooldownMs: 30 });
    await adapter.enrichContext(IDENTITY);
    await adapter.enrichContext(IDENTITY);
    expect(adapter.breakerStats().state).toBe('open');
    // Service recovers; the next queued responses will succeed.
    api.queue({ body: sampleDecisionBody() }, { body: sampleDecisionBody() });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const result = await adapter.enrichContext(IDENTITY);
    expect(result.moderationAvailable).toBe(true);
    expect(result.context?.decisions).toHaveLength(2);
    expect(adapter.breakerStats().state).toBe('closed');
  });

  it('onLog receives warnings on failure but never breaks enrichment', async () => {
    const onLog = vi.fn();
    const adapter = new ModerationAdapter({
      client: {
        baseUrl: 'http://moderation:8080',
        clientId: 'enthusia-support',
        apiKey: 'runtime-test-token',
        fetchFn: downApi().fetch,
      },
      circuitBreaker: { failureThreshold: 5, cooldownMs: 60_000 },
      onLog,
    });
    const result = await adapter.enrichContext(IDENTITY);
    expect(result.moderationAvailable).toBe(false);
    expect(onLog).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('support continues without context'),
      expect.anything(),
    );
  });

  it('breaker stats are exposed for §36 observability', async () => {
    const adapter = makeAdapter(downApi(), { cooldownMs: 60_000 });
    await adapter.enrichContext(IDENTITY);
    const stats = adapter.breakerStats();
    expect(stats.totalCalls).toBeGreaterThan(0);
    expect(stats.totalFailures).toBeGreaterThan(0);
    expect(stats.lastFailureAtMs).not.toBeNull();
  });
});
