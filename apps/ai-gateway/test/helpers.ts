import { Writable } from 'node:stream';
import { createLogger, type EnthusiaLogger } from '@enthusia/logging';
import { Visibility, type ChatRequest } from '@enthusia/contracts';
import { loadGatewayConfig, type GatewayConfig } from '../src/config.js';
import { MockAgent } from '../src/agent.js';
import { AgentRegistry, Router } from '../src/router.js';
import { startGateway, type RunningGateway } from '../src/server.js';

/** Logger that discards everything below fatal (keeps test output clean). */
export function silentLogger(): EnthusiaLogger {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return createLogger({ name: 'ai-gateway-test', level: 'fatal', stream: sink });
}

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides };
}

export function testConfig(envOverrides: Record<string, string> = {}): GatewayConfig {
  return loadGatewayConfig(testEnv(envOverrides));
}

/** Canonical Discord-shaped ChatRequest for tests. */
export function discordChatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    surface: 'discord',
    actor: {
      id: 'discord-user-123',
      type: 'player',
      displayName: 'TestPlayer',
      linkedUuid: '123e4567-e89b-12d3-a456-426614174000',
    },
    conversationId: 'conv-1',
    message: 'What is the server IP?',
    visibilityCeiling: Visibility.PUBLIC,
    ...overrides,
  };
}

export function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` };
}

export interface TestGateway {
  running: RunningGateway;
  config: GatewayConfig;
  mock: MockAgent;
  baseUrl: string;
}

/** Start a real HTTP gateway on an ephemeral port. Caller must close it. */
export async function startTestGateway(
  envOverrides: Record<string, string> = {},
  mock?: MockAgent,
): Promise<TestGateway> {
  const config = testConfig(envOverrides);
  const agent = mock ?? new MockAgent();
  const agents = new AgentRegistry();
  agents.register(agent);
  const running = await startGateway({
    config,
    logger: silentLogger(),
    router: new Router(),
    agents,
  });
  return { running, config, mock: agent, baseUrl: `http://127.0.0.1:${running.port}` };
}

/**
 * Plain GET/HEAD-style request with the same connection hygiene as postJson:
 * 'Connection: close' so pooled keep-alive sockets never leak across the
 * per-test server restarts.
 */
export async function testFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { connection: 'close', ...init.headers },
  });
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: unknown; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    // 'Connection: close' keeps each test isolated: the shared global fetch
    // dispatcher pools keep-alive connections per origin, and a pooled
    // socket from a previous test's (now closed) server can otherwise be
    // reused when the OS reassigns the same ephemeral port, producing
    // intermittent ECONNRESET failures.
    headers: { 'content-type': 'application/json', connection: 'close', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave as null; callers asserting on JSON will fail loudly
  }
  return { status: res.status, headers: res.headers, json, text };
}
