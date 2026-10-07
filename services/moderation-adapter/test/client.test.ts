/**
 * Contract tests for the direct AI-Moderation-API client.
 *
 * These fixtures mirror the actual Policy-v1 readiness and support-context
 * endpoints. The AI Gateway/support LLM is never involved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceError } from '@enthusia/contracts';
import { ModerationServiceClient } from '../src/client.js';
import {
  downApi,
  healthyApi,
  MockModerationApi,
  notReadyHealthBody,
  readyHealthBody,
  sampleDecisionBody,
} from './mocks.js';

const BASE = {
  baseUrl: 'http://moderation:8080',
  clientId: 'enthusia-support',
  apiKey: 'runtime-test-token',
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ModerationServiceClient', () => {
  it('rejects invalid base URLs and missing AI_MOD credential parts', () => {
    expect(() => new ModerationServiceClient({ ...BASE, baseUrl: 'moderation:8080' })).toThrow();
    expect(() => new ModerationServiceClient({ ...BASE, baseUrl: '' })).toThrow();
    expect(() => new ModerationServiceClient({ ...BASE, clientId: '' })).toThrow('clientId');
    expect(() => new ModerationServiceClient({ ...BASE, apiKey: '' })).toThrow('apiKey');
  });

  it('defaults to global fetch and uses the real readiness endpoint', async () => {
    const api = healthyApi();
    vi.stubGlobal('fetch', api.fetch);
    const client = new ModerationServiceClient(BASE);
    const status = await client.queryStatus();

    expect(status).toEqual({
      status: 'ready',
      ready: true,
      schema_version: 3,
    });
    expect(api.calls[0]?.url).toBe('http://moderation:8080/health/ready');
  });

  it('treats structured HTTP 503 not-ready as degraded reachability data', async () => {
    const api = new MockModerationApi({
      status: 503,
      body: notReadyHealthBody(),
    });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });

    await expect(client.queryStatus()).resolves.toEqual({
      status: 'not_ready',
      ready: false,
      schema_version: 3,
    });
  });

  it('does not send support credentials to the unauthenticated health endpoint', async () => {
    let captured: Record<string, string> = {};
    const api = new MockModerationApi({
      body: readyHealthBody(),
      assertRequest: (_input, init) => {
        captured = (init?.headers ?? {}) as Record<string, string>;
      },
    });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });

    await client.queryStatus();

    expect(captured['Authorization']).toBeUndefined();
    expect(captured['X-Client-Id']).toBeUndefined();
    expect(captured['Accept']).toBe('application/json');
  });

  it('throws ExternalServiceError on an unexpected HTTP failure', async () => {
    const api = new MockModerationApi({ status: 500 });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    await expect(client.queryStatus()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('throws on malformed readiness payloads', async () => {
    const api = new MockModerationApi({ body: { status: 'ready', ready: 'yes' } });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    await expect(client.queryStatus()).rejects.toThrow('malformed');
  });

  it('maps network and timeout failures to ExternalServiceError', async () => {
    const down = new ModerationServiceClient({ ...BASE, fetchFn: downApi().fetch });
    await expect(down.queryStatus()).rejects.toBeInstanceOf(ExternalServiceError);

    const hanging = new ModerationServiceClient({
      ...BASE,
      fetchFn: new MockModerationApi({ hang: true }).fetch,
      healthTimeoutMs: 50,
    });
    await expect(hanging.queryStatus()).rejects.toThrow('timed out');
  });

  it('fetches the live support-context route with both required auth headers', async () => {
    let captured: Record<string, string> = {};
    const api = new MockModerationApi({
      body: sampleDecisionBody(),
      assertRequest: (_input, init) => {
        captured = (init?.headers ?? {}) as Record<string, string>;
      },
    });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    const decisions = await client.fetchDecisionContext({
      subjectId: 'canonical-player-42',
    });

    expect(api.calls[0]?.url).toBe(
      'http://moderation:8080/v1/support-context/canonical-player-42?limit=10',
    );
    expect(api.calls[0]?.init?.method).toBe('GET');
    expect(captured['X-Client-Id']).toBe('enthusia-support');
    expect(captured['Authorization']).toBe('Bearer runtime-test-token');
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      eventId: 'event-1',
      semanticLabel: 'SEVERE_HARASSMENT',
      messageAction: 'BLOCK',
      strikeRecommendation: 'STRIKE',
      decisionSource: 'AI',
    });
    expect(decisions[1]).toMatchObject({
      eventId: 'event-2',
      messageAction: 'ALLOW',
      strikeRecommendation: 'EVIDENCE',
      decisionSource: 'ACCEPTED_CORRECTION',
    });
  });

  it('URL-encodes the canonical identity and clamps limits to the API ceiling', async () => {
    const body = sampleDecisionBody();
    body.subject_id = 'canonical/player 42';
    const api = new MockModerationApi({ body });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });

    await client.fetchDecisionContext({
      subjectId: 'canonical/player 42',
      limit: 999,
    });

    expect(api.calls[0]?.url).toBe(
      'http://moderation:8080/v1/support-context/canonical%2Fplayer%2042?limit=25',
    );
  });

  it('drops malformed decisions without exposing unknown/raw fields', async () => {
    const api = new MockModerationApi({
      body: {
        subject_id: 'canonical-player-42',
        decisions: [
          sampleDecisionBody().decisions[0],
          {
            event_id: 'bad-label',
            occurred_at: '2026-09-30T12:00:00Z',
            platform: 'minecraft',
            semantic_label: 'MADE_UP_LABEL',
            message_action: 'BLOCK',
            review_priority: 'NORMAL',
            strike_recommendation: 'STRIKE',
            containment: 'NONE',
            support_flow: 'NONE',
            reason_codes: [],
            decision_source: 'AI',
            text: 'must never enter support context',
          },
        ],
      },
    });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });

    const decisions = await client.fetchDecisionContext({
      subjectId: 'canonical-player-42',
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.eventId).toBe('event-1');
    expect(decisions[0]).not.toHaveProperty('text');
  });

  it('keeps canonical identity and credentials out of HTTP failure diagnostics', async () => {
    const api = new MockModerationApi({ status: 500 });
    const client = new ModerationServiceClient({
      ...BASE,
      apiKey: 'very-sensitive-runtime-token',
      fetchFn: api.fetch,
    });

    let message = '';
    try {
      await client.fetchDecisionContext({ subjectId: 'canonical-private-player-42' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('/v1/support-context/{subject_id}');
    expect(message).not.toContain('canonical-private-player-42');
    expect(message).not.toContain('very-sensitive-runtime-token');
  });

  it('rejects a mismatched subject response instead of attaching history to the wrong player', async () => {
    const body = sampleDecisionBody();
    body.subject_id = 'different-player';
    const client = new ModerationServiceClient({
      ...BASE,
      fetchFn: new MockModerationApi({ body }).fetch,
    });

    await expect(
      client.fetchDecisionContext({ subjectId: 'canonical-player-42' }),
    ).rejects.toThrow('mismatched');
  });

  it('rejects invalid canonical identity values before making a request', async () => {
    const api = new MockModerationApi({ body: sampleDecisionBody() });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });

    await expect(client.fetchDecisionContext({ subjectId: '' })).rejects.toThrow(
      'invalid moderation subject identity',
    );
    expect(api.calls).toHaveLength(0);
  });

  it('never touches the AI Gateway: every request stays on the configured moderation base URL', async () => {
    const api = new MockModerationApi({ body: sampleDecisionBody() });
    const client = new ModerationServiceClient({ ...BASE, fetchFn: api.fetch });
    await client.fetchDecisionContext({ subjectId: 'canonical-player-42' });

    for (const call of api.calls) {
      expect(call.url.startsWith('http://moderation:8080/')).toBe(true);
    }
  });
});
