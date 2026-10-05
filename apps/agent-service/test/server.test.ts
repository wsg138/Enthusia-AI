import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentOrchestrator,
  ToolRegistry,
  type EvidencePlanStep,
  type IntentClassification,
  type InvestigationDecision,
  type Reasoner,
  type ResponseDraft,
} from '@enthusia/agent-core';
import {
  Visibility,
  agentResponseSchema,
  readinessResponseSchema,
  type ChatRequest,
} from '@enthusia/contracts';
import {
  emptyMetricsSnapshot,
  type InferenceClient,
} from '@enthusia/inference-adapter';
import { createLogger } from '@enthusia/logging';
import type { AgentServiceConfig } from '../src/config.js';
import { startAgentService, type RunningAgentService } from '../src/server.js';

class NoFactReasoner implements Reasoner {
  async classifyIntent(): Promise<IntentClassification> {
    return {
      requestClass: 'simple',
      summary: 'no factual claim',
      claims: [],
      needsPrivateContext: false,
      securitySensitive: false,
    };
  }

  async planEvidence(): Promise<EvidencePlanStep[]> {
    return [];
  }

  async nextStep(): Promise<InvestigationDecision> {
    return { action: 'finish', calls: [] };
  }

  async draftResponse(): Promise<ResponseDraft> {
    return {};
  }
}

function config(): AgentServiceConfig {
  return {
    port: 0,
    apiKeys: ['agent-key'],
    maxBodyBytes: 65_536,
    nodeEnv: 'test',
    serviceName: 'agent-service-test',
    serviceVersion: '0.1.0',
    logLevel: 'fatal',
  };
}

function silentLogger() {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return createLogger({
    name: 'agent-service-test',
    level: 'fatal',
    stream: sink,
  });
}

function inference(): Pick<InferenceClient, 'getModels' | 'getMetrics'> {
  return {
    async getModels() {
      return [{ id: 'fake-local-model' }];
    },
    getMetrics() {
      return emptyMetricsSnapshot();
    },
  };
}

function chatRequest(
  visibilityCeiling: Visibility = Visibility.PUBLIC,
): ChatRequest {
  return {
    surface: 'discord',
    actor: { id: 'player-1', type: 'player' },
    conversationId: 'conv-1',
    message: 'hello',
    visibilityCeiling,
  };
}

let running: RunningAgentService | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(): Promise<string> {
  const registry = new ToolRegistry();
  const orchestrator = new AgentOrchestrator({
    reasoner: new NoFactReasoner(),
    registry,
  });
  running = await startAgentService({
    config: config(),
    logger: silentLogger(),
    orchestrator,
    registry,
    inference: inference(),
  });
  return 'http://127.0.0.1:' + running.port;
}

describe('agent service', () => {
  it('protects capabilities and reports the actual empty registry', async () => {
    const baseUrl = await start();

    const denied = await fetch(baseUrl + '/v1/capabilities');
    expect(denied.status).toBe(401);

    const allowed = await fetch(baseUrl + '/v1/capabilities', {
      headers: { authorization: 'Bearer agent-key' },
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({
      reasoner: 'local-inference',
      registeredTools: [],
      toolCount: 0,
    });
  });

  it('reports local inference readiness without exposing credentials', async () => {
    const baseUrl = await start();
    const response = await fetch(baseUrl + '/health/ready');
    expect(response.status).toBe(200);
    const body = readinessResponseSchema.parse(await response.json());
    expect(body.status).toBe('ok');
    expect(body.modelLoaded).toBe(true);
    expect(body.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'local-inference', status: 'ok' }),
        expect.objectContaining({ name: 'tool-registry', status: 'ok' }),
      ]),
    );
  });

  it('rejects a visibility ceiling above the actor grant', async () => {
    const baseUrl = await start();
    const response = await fetch(baseUrl + '/v1/agent/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer agent-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify(chatRequest(Visibility.STAFF)),
    });
    expect(response.status).toBe(403);
  });

  it('serves a contract-valid orchestrated response', async () => {
    const baseUrl = await start();
    const response = await fetch(baseUrl + '/v1/agent/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer agent-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify(chatRequest()),
    });
    expect(response.status).toBe(200);
    const body = agentResponseSchema.parse(await response.json());
    expect(body.text).toContain('could not verify');
    expect(body.sources).toEqual([]);
  });
});
