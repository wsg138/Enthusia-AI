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
  TRACE_ID_HEADER,
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
import type { TicketEvidenceReviewService } from '../src/ticket-evidence-review.js';

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
    memoryPath: undefined,
    ticketBotBaseUrl: undefined,
    ticketBotApiKey: undefined,
    ticketBotTimeoutMs: 10_000,
    staffModerationBaseUrl: undefined,
    staffModerationApiKey: undefined,
    staffModerationTimeoutMs: 10_000,
    policyServerId: undefined,
    policySourceId: undefined,
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

async function start(
  staleTicketDecision?: {
    decide(
      input: unknown,
      traceId?: string,
    ): Promise<{
      decision:
        | 'PING_PLAYER'
        | 'PING_STAFF'
        | 'KEEP_PAUSED'
        | 'ESCALATE_STAFF'
        | 'NO_ACTION';
      reason: string;
    }>;
  },
  ticketEvidenceReview?: Pick<TicketEvidenceReviewService, 'review'>,
): Promise<string> {
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
    ...(staleTicketDecision !== undefined ? { staleTicketDecision } : {}),
    ...(ticketEvidenceReview !== undefined ? { ticketEvidenceReview } : {}),
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
  it('fails safely when stale ticket decision support is unavailable', async () => {
    const baseUrl = await start();
    const response = await fetch(baseUrl + '/v1/ticket/stale-decision', {
      method: 'POST',
      headers: {
        authorization: 'Bearer agent-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ticket: {
          id: '12',
          status: 'open',
          category: 'support',
          priority: 'normal',
          ownerId: '100000000000000001',
          assigneeIds: [],
          lastMeaningfulActivityAt: '2026-09-27T00:00:00.000Z',
          intentionalPause: false,
          previousReminderCount: 0,
          lastReminderAt: null,
        },
        messages: [],
      }),
    });
    expect(response.status).toBe(503);
  });

  it('protects the ticket evidence review endpoint and fails safely when unavailable', async () => {
    const baseUrl = await start();

    const denied = await fetch(baseUrl + '/v1/ticket/evidence-review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: '42' }),
    });
    expect(denied.status).toBe(401);

    const unavailable = await fetch(baseUrl + '/v1/ticket/evidence-review', {
      method: 'POST',
      headers: {
        authorization: 'Bearer agent-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ticketId: '42' }),
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: 'TICKET_EVIDENCE_REVIEW_UNAVAILABLE' },
    });
  });

  it('accepts only the bounded ticket id and returns a validated evidence review', async () => {
    let seenTrace = '';
    let seenInput: unknown;
    const baseUrl = await start(undefined, {
      async review(input, traceId) {
        seenInput = input;
        seenTrace = traceId;
        return {
          ticketId: '42',
          status: 'needs_more_evidence',
          disposition: 'needs_more_evidence',
          summary: 'More context is needed.',
          missingEvidence: ['Provide a wider screenshot.'],
          evidence: {
            eligibleAttachmentCount: 1,
            attemptedCount: 1,
            assessedCount: 1,
            issueCounts: {},
          },
          policy: {
            version: '2026-10-06.1',
            fileVersion: 'sha256:' + 'a'.repeat(64),
            needsMoreContext: true,
          },
          moderation: {
            verified: false,
            duplicateStatus: 'none',
          },
          delivery: null,
        };
      },
    });

    const inboundTrace = '123e4567-e89b-12d3-a456-426614174000';
    const response = await fetch(baseUrl + '/v1/ticket/evidence-review', {
      method: 'POST',
      headers: {
        authorization: 'Bearer agent-key',
        'content-type': 'application/json',
        [TRACE_ID_HEADER]: inboundTrace,
      },
      body: JSON.stringify({ ticketId: '42' }),
    });
    expect(response.status).toBe(200);
    expect(seenInput).toEqual({ ticketId: '42' });
    expect(seenTrace).toBe(inboundTrace);
    expect(response.headers.get(TRACE_ID_HEADER)).toBe(inboundTrace);
    await expect(response.json()).resolves.toMatchObject({
      ticketId: '42',
      status: 'needs_more_evidence',
      moderation: { verified: false },
    });

    const invalid = await fetch(baseUrl + '/v1/ticket/evidence-review', {
      method: 'POST',
      headers: {
        authorization: 'Bearer agent-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ticketId: '42',
        imageUrl: 'https://example.invalid/evidence.png',
      }),
    });
    expect(invalid.status).toBe(400);
  });

  it('does not expose internal evidence-review failure details', async () => {
    const baseUrl = await start(undefined, {
      async review() {
        throw new Error('staff-secret signed-url private-policy-path');
      },
    });
    const response = await fetch(baseUrl + '/v1/ticket/evidence-review', {
      method: 'POST',
      headers: {
        authorization: 'Bearer agent-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ticketId: '42' }),
    });
    expect(response.status).toBe(503);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain('staff-secret');
    expect(body).not.toContain('signed-url');
    expect(body).not.toContain('private-policy-path');
  });

  it('serves a validated stale ticket recommendation', async () => {
    const baseUrl = await start({
      async decide() {
        return {
          decision: 'PING_STAFF',
          reason: 'The next ordinary action belongs to staff.',
        };
      },
    });
    const response = await fetch(baseUrl + '/v1/ticket/stale-decision', {
      method: 'POST',
      headers: {
        authorization: 'Bearer agent-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ticket: {
          id: '12',
          status: 'open',
          category: 'support',
          priority: 'normal',
          ownerId: '100000000000000001',
          assigneeIds: ['100000000000000002'],
          lastMeaningfulActivityAt: '2026-09-27T00:00:00.000Z',
          intentionalPause: false,
          previousReminderCount: 0,
          lastReminderAt: null,
        },
        messages: [
          {
            authorKind: 'player',
            body: 'I uploaded the screenshot you asked for.',
            createdAt: '2026-09-27T00:00:00.000Z',
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      decision: 'PING_STAFF',
      reason: 'The next ordinary action belongs to staff.',
    });
  });

});
