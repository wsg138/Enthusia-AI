import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import { runEscalation } from '../src/index.js';
import { BudgetExceededError, CostTracker } from '../src/budget.js';
import { EscalationDeniedError } from '../src/escalation-policy.js';
import { InvalidPacketError } from '../src/packet.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { OpenAIClient } from '../src/openai-client.js';
import {
  chatCompletionsOk,
  FAKE_API_KEY,
  makePacket,
  startMockOpenAIServer,
} from './helpers.js';

function testConfig(baseUrl: string) {
  return loadConfig({
    OPENAI_API_KEY: FAKE_API_KEY,
    OPENAI_BASE_URL: baseUrl,
    ENTHUSIA_OPENAI_TIMEOUT_MS: '5000',
  });
}

describe('runEscalation end to end (mock OpenAI server)', () => {
  it('returns a valid AgentResponse and records the spend', async () => {
    const server = await startMockOpenAIServer(
      chatCompletionsOk('The vanish listener is registered on the wrong event. Patch: ...'),
    );
    const tracker = new CostTracker(
      {
        maxUsdPerRequest: 2,
        maxUsdPerDay: 10,
        maxEscalationsPerRequest: 3,
      },
      {},
    );
    try {
      const config = testConfig(server.url);
      const result = await runEscalation(
        {
          decision: {
            target: 'openai',
            reason: 'Engineering-class request',
            packetRef: 'packet:trace-1',
          },
          packet: makePacket(),
          escalationsUsedForTrace: 0,
        },
        {
          config,
          client: new OpenAIClient({
            apiKey: FAKE_API_KEY,
            baseUrl: server.url,
            timeoutMs: 5000,
          }),
          tracker,
        },
      );

      expect(result.kind).toBe('coding');
      expect(result.model).toBe(config.modelSelection.coding);
      expect(result.estimatedCostUsd).toBeGreaterThan(0);

      expect(result.analysisContent).toBe(
        'The vanish listener is registered on the wrong event. Patch: ...',
      );
      const response = result.response;
      expect(response.traceId).toBe('trace-1');
      expect(response.text).toContain('awaiting local fact verification');
      expect(response.text).not.toContain('listener is registered');
      expect(response.escalation).not.toBeNull();
      expect(response.escalation?.target).toBe('strong-model');
      expect(response.escalation?.reason).toBe('Engineering-class request');
      expect(response.escalation?.context?.['packetRef']).toBe('packet:trace-1');
      // Evidence citations carried through for grounding.
      expect(response.sources.length).toBeGreaterThan(0);
      expect(response.sources[0]?.artifactId).toContain('EnthusiaStaff');
      expect(response.sources[0]?.visibility).toBe(Visibility.STAFF);
      expect(response.actions).toHaveLength(1);
      expect(response.actions[0]?.type).toBe('escalation.completed');
      expect(response.actions[0]?.payload?.['requiresLocalVerification']).toBe(true);

      // Cost tracking: exactly one recorded call with positive spend.
      const summary = tracker.summary();
      expect(summary.totalCalls).toBe(1);
      expect(summary.dayCalls).toBe(1);
      expect(summary.daySpendUsd).toBeCloseTo(result.estimatedCostUsd, 9);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('refuses without an API key before touching the network', async () => {
    const server = await startMockOpenAIServer(chatCompletionsOk('x'));
    try {
      const config = loadConfig({
        OPENAI_BASE_URL: server.url,
        // No OPENAI_API_KEY.
      });
      await expect(
        runEscalation(
          {
            decision: { target: 'openai', reason: 'x' },
            packet: makePacket(),
            escalationsUsedForTrace: 0,
          },
          { config },
        ),
      ).rejects.toBeInstanceOf(ConfigError);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('validates the packet before anything else', async () => {
    const server = await startMockOpenAIServer(chatCompletionsOk('x'));
    try {
      await expect(
        runEscalation(
          {
            decision: { target: 'openai', reason: 'x' },
            packet: makePacket({ userQuestion: '' }),
            escalationsUsedForTrace: 0,
          },
          { config: testConfig(server.url) },
        ),
      ).rejects.toBeInstanceOf(InvalidPacketError);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('denies policy violations without calling the API', async () => {
    const server = await startMockOpenAIServer(chatCompletionsOk('x'));
    try {
      await expect(
        runEscalation(
          {
            decision: { target: 'staff', reason: 'human review' },
            packet: makePacket(),
            escalationsUsedForTrace: 0,
          },
          { config: testConfig(server.url) },
        ),
      ).rejects.toBeInstanceOf(EscalationDeniedError);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('enforces the budget BEFORE the API call (zero requests on breach)', async () => {
    const server = await startMockOpenAIServer(chatCompletionsOk('x'));
    try {
      const config = loadConfig({
        OPENAI_API_KEY: FAKE_API_KEY,
        OPENAI_BASE_URL: server.url,
        ENTHUSIA_OPENAI_DAILY_BUDGET_USD: '0',
      });
      await expect(
        runEscalation(
          {
            decision: { target: 'openai', reason: 'x' },
            packet: makePacket(),
            escalationsUsedForTrace: 0,
          },
          { config },
        ),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
