import { describe, expect, it } from 'vitest';
import type {
  GenerationRequest,
  GenerationResult,
} from '@enthusia/inference-adapter';
import {
  StaleTicketDecisionService,
  type StaleTicketDecisionRequest,
} from '../src/stale-ticket.js';

class FakeCompletionClient {
  readonly calls: GenerationRequest[] = [];

  constructor(private readonly outputs: string[]) {}

  async complete(request: GenerationRequest): Promise<GenerationResult> {
    this.calls.push(request);
    const content = this.outputs.shift();
    if (content === undefined) throw new Error('no fake completion queued');
    return {
      content,
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: 'fake-local-model',
      latencyMs: 1,
      attempts: 1,
    };
  }
}

function request(
  overrides: Partial<StaleTicketDecisionRequest['ticket']> = {},
): StaleTicketDecisionRequest {
  return {
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
      ...overrides,
    },
    messages: [
      {
        authorKind: 'staff',
        body: 'Could you send the screenshot showing the error?',
        createdAt: '2026-09-26T23:50:00.000Z',
      },
    ],
  };
}

describe('StaleTicketDecisionService', () => {
  it('never calls the model for an intentionally paused ticket', async () => {
    const client = new FakeCompletionClient([]);
    const service = new StaleTicketDecisionService(client);

    await expect(
      service.decide(request({ intentionalPause: true })),
    ).resolves.toEqual({
      decision: 'KEEP_PAUSED',
      reason: 'Ticket is intentionally paused.',
    });
    expect(client.calls).toHaveLength(0);
  });

  it('never calls the model for a non-open ticket', async () => {
    const client = new FakeCompletionClient([]);
    const service = new StaleTicketDecisionService(client);

    await expect(
      service.decide(request({ status: 'closed' })),
    ).resolves.toEqual({
      decision: 'NO_ACTION',
      reason: 'Ticket lifecycle is not open.',
    });
    expect(client.calls).toHaveLength(0);
  });

  it('returns only a validated typed recommendation', async () => {
    const client = new FakeCompletionClient([
      JSON.stringify({
        decision: 'PING_PLAYER',
        reason: 'The next step is waiting on player-provided evidence.',
      }),
    ]);
    const service = new StaleTicketDecisionService(client);

    await expect(service.decide(request())).resolves.toEqual({
      decision: 'PING_PLAYER',
      reason: 'The next step is waiting on player-provided evidence.',
    });
    expect(client.calls).toHaveLength(1);
  });

  it('rejects malformed or extra model control output', async () => {
    const malformed = new StaleTicketDecisionService(
      new FakeCompletionClient(['not json']),
    );
    await expect(malformed.decide(request())).rejects.toThrow('non-JSON');

    const extra = new StaleTicketDecisionService(
      new FakeCompletionClient([
        JSON.stringify({
          decision: 'PING_STAFF',
          reason: 'Staff should review.',
          message: 'model must not control delivery wording',
        }),
      ]),
    );
    await expect(extra.decide(request())).rejects.toThrow(
      'invalid JSON shape',
    );
  });
});
