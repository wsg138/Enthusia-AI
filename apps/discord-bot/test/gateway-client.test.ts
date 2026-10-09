/**
 * Tests for the AI Gateway client: the mock stub, and the HTTP client
 * against a local throwaway server (no W02 dependency, no real network
 * beyond loopback).
 */
import { TRACE_ID_HEADER, Visibility, agentResponseSchema, type ChatRequest } from '@enthusia/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { HttpAiGatewayClient, MockAiGatewayClient, createGatewayClient } from '../src/gateway-client.js';
import { nullLogger, testOptions } from './mock-port.js';

function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    surface: 'discord',
    actor: { id: 'user-1', type: 'player', displayName: 'player1' },
    conversationId: 'discord:guild-1:channel-1',
    message: 'what is the server ip?',
    context: {},
    visibilityCeiling: Visibility.PUBLIC,
    traceId: '123e4567-e89b-42d3-a456-426614174000',
    ...overrides,
  };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Start a loopback server; `handler` sees the raw request. */
async function startServer(
  handler: (req: { method: string | undefined; url: string | undefined; headers: Record<string, string | string[] | undefined>; body: string }, respond: (status: number, body: string) => void) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      handler(
        { method: req.method, url: req.url, headers: req.headers, body },
        (status, responseBody) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(responseBody);
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function agentResponseBody(traceId: string): string {
  return JSON.stringify({
    text: 'The server IP is play.enthusia.example.',
    actions: [],
    sources: [],
    memoryUpdates: [],
    escalation: null,
    traceId,
  });
}

describe('MockAiGatewayClient', () => {
  it('returns a schema-valid AgentResponse marked as a stub', async () => {
    const client = new MockAiGatewayClient();
    const response = await client.sendChat(chatRequest());
    expect(agentResponseSchema.safeParse(response).success).toBe(true);
    expect(response.text).toContain('mock gateway');
    expect(response.traceId).toBe('123e4567-e89b-42d3-a456-426614174000');
  });
});

describe('createGatewayClient', () => {
  it('builds the mock client by default', () => {
    expect(createGatewayClient(testOptions(), nullLogger())).toBeInstanceOf(MockAiGatewayClient);
  });

  it('builds the HTTP client when the mock is disabled', () => {
    expect(createGatewayClient(testOptions({ useMockGateway: false }), nullLogger())).toBeInstanceOf(
      HttpAiGatewayClient,
    );
  });
});

describe('HttpAiGatewayClient', () => {
  it('POSTs the ChatRequest to /v1/chat with the trace header', async () => {
    let seen: { method: string | undefined; url: string | undefined; traceHeader: string | undefined; authHeader: string | undefined; body: ChatRequest | undefined } | null = null;
    const baseUrl = await startServer((req, respond) => {
      const rawTrace = req.headers[TRACE_ID_HEADER];
      seen = {
        method: req.method,
        url: req.url,
        traceHeader: Array.isArray(rawTrace) ? rawTrace[0] : rawTrace,
        authHeader: Array.isArray(req.headers.authorization)
          ? req.headers.authorization[0]
          : req.headers.authorization,
        body: JSON.parse(req.body) as ChatRequest,
      };
      respond(200, agentResponseBody('123e4567-e89b-42d3-a456-426614174000'));
    });

    const client = new HttpAiGatewayClient(baseUrl, 5000, nullLogger(), 'gateway-secret');
    const response = await client.sendChat(chatRequest());

    expect(seen).not.toBeNull();
    expect(seen!.method).toBe('POST');
    expect(seen!.url).toBe('/v1/chat');
    expect(seen!.traceHeader).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(seen!.authHeader).toBe('Bearer gateway-secret');
    expect(seen!.body!.message).toBe('what is the server ip?');
    expect(seen!.body!.surface).toBe('discord');
    expect(response.text).toContain('play.enthusia.example');
  });

  it('preserves explicit Agent outcomes across the real HTTP boundary', async () => {
    for (const status of ['answered', 'unverified', 'error'] as const) {
      const baseUrl = await startServer((_req, respond) => {
        const payload = JSON.parse(agentResponseBody('123e4567-e89b-42d3-a456-426614174000')) as Record<string, unknown>;
        payload['outcome'] = status;
        respond(200, JSON.stringify(payload));
      });
      const client = new HttpAiGatewayClient(baseUrl, 5000, nullLogger());
      const response = await client.sendChat(chatRequest());
      expect(response.outcome).toBe(status);
    }
  });

  it('maps gateway 500s to ExternalServiceError', async () => {
    const baseUrl = await startServer((_req, respond) => {
      respond(500, JSON.stringify({ error: 'boom' }));
    });
    const client = new HttpAiGatewayClient(baseUrl, 5000, nullLogger());
    await expect(client.sendChat(chatRequest())).rejects.toMatchObject({ code: 'EXTERNAL_SERVICE_ERROR' });
  });

  it('preserves gateway rate limiting rather than reporting an outage', async () => {
    const baseUrl = await startServer((_req, respond) => {
      respond(429, JSON.stringify({ error: { code: 'RATE_LIMITED' } }));
    });
    const client = new HttpAiGatewayClient(baseUrl, 5000, nullLogger());
    await expect(client.sendChat(chatRequest())).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
  });

  it('preserves gateway timeout status without converting it to a generic outage', async () => {
    const baseUrl = await startServer((_req, respond) => {
      respond(504, JSON.stringify({ error: { code: 'TOOL_TIMEOUT' } }));
    });
    const client = new HttpAiGatewayClient(baseUrl, 5000, nullLogger());
    await expect(client.sendChat(chatRequest())).rejects.toMatchObject({ code: 'TOOL_TIMEOUT', statusCode: 504 });
  });

  it('maps malformed responses to ValidationError', async () => {
    const baseUrl = await startServer((_req, respond) => {
      respond(200, JSON.stringify({ text: 42 }));
    });
    const client = new HttpAiGatewayClient(baseUrl, 5000, nullLogger());
    await expect(client.sendChat(chatRequest())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('maps timeouts to ToolTimeoutError', async () => {
    const baseUrl = await startServer(() => {
      // Never respond: the client must time out.
    });
    const client = new HttpAiGatewayClient(baseUrl, 50, nullLogger());
    await expect(client.sendChat(chatRequest())).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' });
  });
});
