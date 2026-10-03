import { describe, expect, it } from 'vitest';
import {
  EnthusiaError,
  NotFoundError,
  Visibility,
  agentResponseSchema,
} from '@enthusia/contracts';
import { MockAgent, withTimeout, type AgentContext } from '../src/agent.js';
import { AgentRegistry, Router } from '../src/router.js';
import { discordChatRequest } from './helpers.js';

const TRACE = '123e4567-e89b-12d3-a456-426614174000';

function agentContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    traceId: TRACE,
    visibilityCeiling: Visibility.PUBLIC,
    deadlineMs: Date.now() + 30_000,
    ...overrides,
  };
}

describe('Router', () => {
  it('routes every surface to the mock agent (W02)', () => {
    const router = new Router();
    for (const surface of ['discord', 'minecraft', 'ticket', 'staff'] as const) {
      const decision = router.route(discordChatRequest({ surface }));
      expect(decision.agentName).toBe('mock-agent');
      expect(decision.reason).toContain(surface);
    }
  });
});

describe('AgentRegistry', () => {
  it('returns registered agents by name', () => {
    const registry = new AgentRegistry();
    const mock = new MockAgent();
    registry.register(mock);
    expect(registry.get('mock-agent')).toBe(mock);
    expect(registry.names()).toEqual(['mock-agent']);
  });

  it('throws NotFoundError for unknown agent names', () => {
    const registry = new AgentRegistry();
    let err: unknown;
    try {
      registry.get('llama');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).statusCode).toBe(404);
  });
});

describe('MockAgent', () => {
  it('returns a contract-valid AgentResponse carrying the trace ID', async () => {
    const mock = new MockAgent();
    const request = discordChatRequest();
    const response = await mock.chat(request, agentContext());
    expect(agentResponseSchema.safeParse(response).success).toBe(true);
    expect(response.traceId).toBe(TRACE);
    expect(response.escalation).toBeNull();
    expect(response.text).toContain('[mock-agent]');
    expect(response.text).toContain(request.message);
    expect(response.text).toContain('surface=discord');
  });

  it('propagates the effective visibility ceiling', async () => {
    const mock = new MockAgent();
    const response = await mock.chat(
      discordChatRequest(),
      agentContext({ visibilityCeiling: Visibility.STAFF }),
    );
    expect(response.text).toContain('ceiling=STAFF');
  });

  it('ping resolves when up and rejects when down', async () => {
    const mock = new MockAgent();
    await expect(mock.ping()).resolves.toMatchObject({ latencyMs: expect.any(Number) });
    mock.setDown(true);
    await expect(mock.ping()).rejects.toThrow();
    await expect(mock.chat(discordChatRequest(), agentContext())).rejects.toThrow();
  });
});

describe('withTimeout', () => {
  it('resolves when the promise beats the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), Date.now() + 1000, 'test')).resolves.toBe(
      'ok',
    );
  });

  it('rejects with a 504 EnthusiaError when the deadline passes', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5000));
    let err: unknown;
    try {
      await withTimeout(slow, Date.now() + 20, 'slow-agent');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnthusiaError);
    expect((err as EnthusiaError).code).toBe('AGENT_TIMEOUT');
    expect((err as EnthusiaError).statusCode).toBe(504);
  });

  it('rejects immediately when the deadline already passed', async () => {
    await expect(
      withTimeout(Promise.resolve('ok'), Date.now() - 1, 'test'),
    ).rejects.toMatchObject({ code: 'AGENT_TIMEOUT', statusCode: 504 });
  });
});
