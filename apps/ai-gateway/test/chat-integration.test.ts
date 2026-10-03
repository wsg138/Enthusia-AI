import { afterEach, describe, expect, it } from 'vitest';
import {
  TRACE_ID_HEADER,
  Visibility,
  agentResponseSchema,
  isValidTraceId,
  type AgentResponse,
} from '@enthusia/contracts';
import { MockAgent } from '../src/agent.js';
import {
  authHeaders,
  discordChatRequest,
  postJson,
  startTestGateway,
  type TestGateway,
} from './helpers.js';

const API_KEY = 'test-service-key';

let gateway: TestGateway | undefined;

afterEach(async () => {
  await gateway?.running.close();
  gateway = undefined;
});

/** Gateway with service auth enabled. */
async function startAuthed(overrides: Record<string, string> = {}): Promise<TestGateway> {
  gateway = await startTestGateway({ ENTHUSIA_GATEWAY_API_KEYS: API_KEY, ...overrides });
  return gateway;
}

describe('POST /v1/chat — happy path', () => {
  it('accepts a Discord-shaped ChatRequest and returns a typed AgentResponse', async () => {
    gateway = await startTestGateway();
    const request = discordChatRequest();
    const { status, headers, json } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      request,
    );
    expect(status).toBe(200);
    expect(agentResponseSchema.safeParse(json).success).toBe(true);
    const response = json as AgentResponse;
    expect(response.text).toContain('[mock-agent]');
    expect(response.text).toContain('What is the server IP?');
    expect(response.escalation).toBeNull();
    // Trace ID is generated on ingress and echoed in body + header.
    expect(isValidTraceId(response.traceId)).toBe(true);
    expect(headers.get(TRACE_ID_HEADER)).toBe(response.traceId);
  });

  it('propagates a caller-supplied trace ID from the header', async () => {
    gateway = await startTestGateway();
    const traceId = 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee';
    const { status, headers, json } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      discordChatRequest(),
      { [TRACE_ID_HEADER]: traceId },
    );
    expect(status).toBe(200);
    expect((json as AgentResponse).traceId).toBe(traceId);
    expect(headers.get(TRACE_ID_HEADER)).toBe(traceId);
  });

  it('honors a valid body traceId when no header is present', async () => {
    gateway = await startTestGateway();
    const traceId = '11111111-2222-4333-8444-555555555555';
    const { status, json } = await postJson(`${gateway.baseUrl}/v1/chat`, {
      ...discordChatRequest(),
      traceId,
    });
    expect(status).toBe(200);
    expect((json as AgentResponse).traceId).toBe(traceId);
  });

  it('generates a fresh trace ID for invalid caller-supplied values', async () => {
    gateway = await startTestGateway();
    const { status, json } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      discordChatRequest(),
      { [TRACE_ID_HEADER]: 'not-a-uuid' },
    );
    expect(status).toBe(200);
    const traceId = (json as AgentResponse).traceId;
    expect(isValidTraceId(traceId)).toBe(true);
    expect(traceId).not.toBe('not-a-uuid');
  });

  it('propagates the effective visibility ceiling downstream', async () => {
    gateway = await startTestGateway();
    const { status, json } = await postJson(`${gateway.baseUrl}/v1/chat`, {
      ...discordChatRequest(),
      actor: { id: 'staff-1', type: 'staff', displayName: 'StaffMember' },
      visibilityCeiling: Visibility.STAFF,
    });
    expect(status).toBe(200);
    expect((json as AgentResponse).text).toContain('ceiling=STAFF');
  });
});

describe('POST /v1/chat — authentication', () => {
  it('returns 401 without a key when keys are configured', async () => {
    gateway = await startAuthed();
    const { status, json } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      discordChatRequest(),
    );
    expect(status).toBe(401);
    expect((json as { error: { code: string; traceId: string } }).error.code).toBe(
      'AUTHENTICATION_FAILED',
    );
  });

  it('accepts the request with a valid key', async () => {
    gateway = await startAuthed();
    const { status } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      discordChatRequest(),
      authHeaders(API_KEY),
    );
    expect(status).toBe(200);
  });

  it('rejects unauthenticated malformed input before JSON parsing', async () => {
    gateway = await startAuthed();
    const { status, json } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      '{not json',
    );
    expect(status).toBe(401);
    expect((json as { error: { code: string } }).error.code).toBe(
      'AUTHENTICATION_FAILED',
    );
  });

  it('works without a key when no keys are configured', async () => {
    gateway = await startTestGateway();
    const { status } = await postJson(`${gateway.baseUrl}/v1/chat`, discordChatRequest());
    expect(status).toBe(200);
  });
});

describe('POST /v1/chat — validation', () => {
  it('returns 400 for invalid JSON', async () => {
    gateway = await startTestGateway();
    const { status, json } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      '{not json',
    );
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe('INVALID_JSON');
  });

  it('returns 400 for schema violations', async () => {
    gateway = await startTestGateway();
    const bad = discordChatRequest();
    // @ts-expect-error intentionally invalid: surface is not in the allowlist
    bad.surface = 'irc';
    const { status, json } = await postJson(`${gateway.baseUrl}/v1/chat`, bad);
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns a structured 413 when the HTTP body exceeds the size limit', async () => {
    gateway = await startTestGateway({ ENTHUSIA_GATEWAY_MAX_BODY_BYTES: '64' });
    const { status, json } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      { ...discordChatRequest(), message: 'x'.repeat(256) },
    );
    expect(status).toBe(413);
    expect((json as { error: { code: string } }).error.code).toBe('REQUEST_TOO_LARGE');
  });

  it('returns 413 when the message exceeds the size limit', async () => {
    gateway = await startTestGateway({ ENTHUSIA_GATEWAY_MAX_MESSAGE_BYTES: '16' });
    const { status, json } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      discordChatRequest({ message: 'this message is definitely longer than sixteen bytes' }),
    );
    expect(status).toBe(413);
    expect((json as { error: { code: string } }).error.code).toBe('MESSAGE_TOO_LARGE');
  });

  it('returns 403 for a surface outside the allowlist', async () => {
    gateway = await startTestGateway({ ENTHUSIA_GATEWAY_ALLOWED_SURFACES: 'discord' });
    const { status, json } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      discordChatRequest({ surface: 'minecraft' }),
    );
    expect(status).toBe(403);
    expect((json as { error: { code: string } }).error.code).toBe('AUTHORIZATION_ERROR');
  });

  it('returns 403 when the ceiling exceeds the actor grant', async () => {
    gateway = await startTestGateway();
    const { status, json } = await postJson(`${gateway.baseUrl}/v1/chat`, {
      ...discordChatRequest(),
      visibilityCeiling: Visibility.STAFF,
    });
    expect(status).toBe(403);
    expect((json as { error: { code: string } }).error.code).toBe('AUTHORIZATION_ERROR');
  });
});

describe('POST /v1/chat — rate limiting', () => {
  it('returns 429 with Retry-After once the per-user limit is hit', async () => {
    gateway = await startTestGateway({ ENTHUSIA_GATEWAY_RATE_LIMIT_USER_PER_MIN: '2' });
    const url = `${gateway.baseUrl}/v1/chat`;
    expect((await postJson(url, discordChatRequest())).status).toBe(200);
    expect((await postJson(url, discordChatRequest())).status).toBe(200);
    const third = await postJson(url, discordChatRequest());
    expect(third.status).toBe(429);
    const retryAfter = third.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(
      (third.json as { error: { code: string; retryAfterSeconds: number } }).error.code,
    ).toBe('RATE_LIMITED');
  });
});

describe('POST /v1/chat — downstream failure', () => {
  /** Agent that never responds: exercises the gateway timeout. */
  class HangingAgent extends MockAgent {
    override async chat(): Promise<AgentResponse> {
      // Unref'd so the stray timer cannot hold the test process open.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5000).unref();
      });
      throw new Error('should have timed out');
    }
  }

  it('returns 504 when the downstream agent exceeds its timeout', async () => {
    gateway = await startTestGateway(
      { ENTHUSIA_GATEWAY_AGENT_TIMEOUT_MS: '50' },
      new HangingAgent(),
    );
    const { status, json } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      discordChatRequest(),
    );
    expect(status).toBe(504);
    expect((json as { error: { code: string } }).error.code).toBe('AGENT_TIMEOUT');
  });

  it('returns 502 when the downstream agent throws', async () => {
    const failing = new MockAgent();
    failing.setDown(true);
    gateway = await startTestGateway({}, failing);
    const { status, json } = await postJson(
      `${gateway.baseUrl}/v1/chat`,
      discordChatRequest(),
    );
    expect(status).toBe(502);
    expect((json as { error: { code: string } }).error.code).toBe('EXTERNAL_SERVICE_ERROR');
  });
});
