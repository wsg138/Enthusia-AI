import { describe, expect, it } from 'vitest';
import {
  Visibility,
  type AgentResponse,
  type ChatRequest,
} from '@enthusia/contracts';
import { HttpAgent } from '../src/remote-agent.js';
import type { AgentContext } from '../src/agent.js';

const TRACE = '123e4567-e89b-12d3-a456-426614174000';

function request(): ChatRequest {
  return {
    surface: 'staff',
    actor: { id: 'staff-1', type: 'staff' },
    conversationId: 'conv-1',
    message: 'check something',
    visibilityCeiling: Visibility.SYSTEM_INTERNAL,
  };
}

function response(): AgentResponse {
  return {
    text: 'ok',
    actions: [],
    sources: [],
    memoryUpdates: [],
    escalation: null,
    traceId: TRACE,
  };
}

function context(): AgentContext {
  return {
    traceId: TRACE,
    visibilityCeiling: Visibility.STAFF,
    deadlineMs: Date.now() + 10_000,
  };
}

describe('HttpAgent', () => {
  it('forwards the effective visibility ceiling and internal service auth', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify(response()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const agent = new HttpAgent({
      baseUrl: 'http://agent.internal/',
      apiKey: 'agent-secret',
      fetchImpl,
    });
    const result = await agent.chat(request(), context());

    expect(result.text).toBe('ok');
    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.url).toBe('http://agent.internal/v1/agent/chat');
    const headers = new Headers(call.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer agent-secret');
    expect(headers.get('x-enthusia-trace-id')).toBe(TRACE);
    const body = JSON.parse(String(call.init?.body)) as ChatRequest;
    expect(body.visibilityCeiling).toBe(Visibility.STAFF);
    expect(body.traceId).toBe(TRACE);
  });

  it('uses readiness rather than assuming the process is healthy', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          status: 'ok',
          version: '0.1.0',
          uptimeSeconds: 10,
          dependencies: [],
          modelLoaded: true,
          activeRequests: 0,
          queueDepth: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const agent = new HttpAgent({
      baseUrl: 'http://agent.internal',
      fetchImpl,
    });
    await expect(agent.ping()).resolves.toEqual({
      latencyMs: expect.any(Number),
    });
  });

  it('rejects a contract-invalid downstream response', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ text: 'missing fields' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const agent = new HttpAgent({
      baseUrl: 'http://agent.internal',
      fetchImpl,
    });
    await expect(agent.chat(request(), context())).rejects.toThrow(
      'invalid response',
    );
  });
});
