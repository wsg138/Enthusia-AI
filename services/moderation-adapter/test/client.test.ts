/**
 * @enthusia/moderation-adapter — moderation service client tests (W15).
 *
 * Unit tests with a mock moderation API (NO real service connection).
 * The client talks directly to the moderation API — never through the
 * support LLM or the AI Gateway (§10.1, §21).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceError } from '@enthusia/contracts';
import { ModerationServiceClient } from '../src/client.js';
import { downApi, healthyApi, MockModerationApi, sampleDecisionBody } from './mocks.js';

const BASE = { baseUrl: 'http://moderation:8080' } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ModerationServiceClient', () => {
  it('rejects a non-http(s) baseUrl', () => {
    expect(() => new ModerationServiceClient({ baseUrl: 'moderation:8080' })).toThrow();
    expect(() => new ModerationServiceClient({ baseUrl: '' })).toThrow();
  });

  it('defaults to global fetch when no fetch implementation is injected', async () => {
    const api = healthyApi();
    vi.stubGlobal('fetch', api.fetch);
    const client = new ModerationServiceClient(BASE);
    const status = await client.queryStatus();
    expect(status.status).toBe('ok');
    expect(api.calls[0]?.url).toBe('http://moderation:8080/health');
  });

  it('queries moderation status (acceptance: client can query moderation status)', async () => {
    const api = healthyApi();
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    const status = await client.queryStatus();
    expect(status.status).toBe('ok');
    expect(status.version).toBe('mod-1.4.2');
    expect(api.calls[0]?.url).toBe('http://moderation:8080/health');
  });

  it('maps a self-reported degraded status through unchanged', async () => {
    const api = new MockModerationApi({ body: { status: 'degraded' } });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    const status = await client.queryStatus();
    expect(status.status).toBe('degraded');
  });

  it('throws ExternalServiceError on HTTP 500', async () => {
    const api = new MockModerationApi({ status: 500 });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    await expect(client.queryStatus()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('throws ExternalServiceError on malformed /health payload', async () => {
    const api = new MockModerationApi({ body: { status: 'everything-is-fine' } });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    await expect(client.queryStatus()).rejects.toThrow('malformed');
  });

  it('throws ExternalServiceError when the network is down', async () => {
    const client = new ModerationServiceClient({ ...BASE, fetchFn: downApi().fetch });
    await expect(client.queryStatus()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('times out instead of hanging forever (aborted request → ExternalServiceError)', async () => {
    const api = new MockModerationApi({ hang: true });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch, healthTimeoutMs: 50 });
    await expect(client.queryStatus()).rejects.toThrow('timed out');
  });

  it('sends the Bearer token when configured, and never logs it', async () => {
    const api = new MockModerationApi({ body: { status: 'ok' } });
    const client = new ModerationServiceClient({
      ...BASE,
      apiKey: 'secret-token',
      fetchFn: api.fetch,
    });
    let captured: Record<string, string> = {};
    api.queue({
      body: { status: 'ok' },
      assertRequest: (_input, init) => {
        captured = (init?.headers ?? {}) as Record<string, string>;
      },
    });
    await client.queryStatus();
    expect(captured['Authorization']).toBe('Bearer secret-token');
  });

  it('fetches decision context and normalizes decisions', async () => {
    const api = new MockModerationApi({ body: sampleDecisionBody() });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    const decisions = await client.fetchDecisionContext({ subjectId: 'mod-subject-42' });
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.verdict).toBe('flagged');
    expect(decisions[0]?.categories).toEqual(['spam']);
    expect(decisions[1]?.appealed).toBeUndefined();
    const call = api.calls[0];
    expect(call?.url).toBe('http://moderation:8080/v1/decisions/context');
    expect(JSON.parse(call?.init?.body as string)).toMatchObject({
      subjectId: 'mod-subject-42',
      limit: 10,
    });
  });

  it('drops malformed decisions individually instead of failing the whole response', async () => {
    const api = new MockModerationApi({
      body: {
        subjectId: 'mod-subject-42',
        decisions: [
          { id: 'good', verdict: 'clean', categories: [], summary: 'Fine.', decidedAt: '2026-09-01T00:00:00.000Z' },
          { id: 'bad-verdict', verdict: 'maybe', summary: '???', decidedAt: '2026-09-01T00:00:00.000Z' },
          { id: 'no-summary', verdict: 'flagged', decidedAt: '2026-09-01T00:00:00.000Z' },
          'not-an-object',
        ],
      },
    });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    const decisions = await client.fetchDecisionContext({ subjectId: 'mod-subject-42' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.id).toBe('good');
  });

  it('throws ExternalServiceError on a malformed context payload', async () => {
    const api = new MockModerationApi({ body: { decisions: 'nope' } });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    await expect(client.fetchDecisionContext({ subjectId: 'x' })).rejects.toThrow('malformed');
  });

  it('never touches the AI Gateway: requests go only to baseUrl', async () => {
    const api = new MockModerationApi({ body: sampleDecisionBody() });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    await client.fetchDecisionContext({ subjectId: 'mod-subject-42' });
    for (const call of api.calls) {
      expect(call.url.startsWith('http://moderation:8080/')).toBe(true);
    }
  });
});
