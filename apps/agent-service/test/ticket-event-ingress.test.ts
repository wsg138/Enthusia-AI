import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TicketEventIngress } from '../src/ticket-event-ingress.js';
import type { TicketEvidenceRuntimeResult } from '../src/ticket-evidence-runtime.js';

const SECRET = 'ticket-event-test-secret-that-is-long-enough';

function event(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'ticket.message',
    event_id: 'ticket-message-123',
    ticket_id: '42',
    occurred_at: '2026-10-06T18:30:00.000Z',
    source: 'ticket-bot',
    actor: {
      id: '100000000000000001',
      kind: 'player',
      displayName: 'Reporter',
    },
    payload: {
      message_id: '120000000000000001',
      author: {
        id: '100000000000000001',
        kind: 'player',
        displayName: 'Reporter',
      },
      body: 'Screenshot attached.',
    },
    ...overrides,
  };
}

function signedBody(value: unknown): {
  raw: Buffer;
  signature: string;
} {
  const raw = Buffer.from(JSON.stringify(value));
  return {
    raw,
    signature: createHmac('sha256', SECRET).update(raw).digest('hex'),
  };
}

function runtimeResult(
  status: TicketEvidenceRuntimeResult['status'],
  retryable = false,
): TicketEvidenceRuntimeResult {
  return {
    status,
    retryable,
    pipeline: null,
  };
}

describe('TicketEventIngress', () => {
  it('reviews a valid signed player ticket.message exactly once', async () => {
    const review = vi.fn(async () =>
      runtimeResult('no_escalation'));
    const ingress = new TicketEventIngress(SECRET, { review });
    const signed = signedBody(event());

    const response = await ingress.handle(signed.raw, signed.signature);

    expect(response).toEqual({
      status: 200,
      body: {
        accepted: true,
        eventType: 'ticket.message',
        reviewStatus: 'no_escalation',
        retryable: false,
      },
    });
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]?.[0]).toBe('42');
    expect(review.mock.calls[0]?.[1]).toMatch(/^ticket-event-[a-f0-9]{32}$/);
  });

  it('rejects an invalid signature before parsing or review', async () => {
    const review = vi.fn(async () =>
      runtimeResult('no_escalation'));
    const ingress = new TicketEventIngress(SECRET, { review });
    const raw = Buffer.from('{"not":"even a valid event"}');

    const response = await ingress.handle(raw, '00'.repeat(32));

    expect(response.status).toBe(401);
    expect(response.body.error?.code).toBe('INVALID_SIGNATURE');
    expect(review).not.toHaveBeenCalled();
  });

  it('ignores non-message events and system-authored messages', async () => {
    const review = vi.fn(async () =>
      runtimeResult('no_escalation'));
    const ingress = new TicketEventIngress(SECRET, { review });

    const created = signedBody(event({
      type: 'ticket.created',
      payload: {
        category: 'report',
        subject: 'Report',
        owner: {
          id: '100000000000000001',
          kind: 'player',
        },
      },
    }));
    expect(
      (await ingress.handle(created.raw, created.signature)).status,
    ).toBe(200);

    const systemMessage = signedBody(event({
      actor: {
        id: 'enthusia-ai/system',
        kind: 'system',
      },
      payload: {
        message_id: '120000000000000002',
        author: {
          id: 'enthusia-ai/system',
          kind: 'system',
        },
        body: 'Automated evidence summary.',
      },
    }));
    expect(
      (await ingress.handle(systemMessage.raw, systemMessage.signature)).status,
    ).toBe(200);

    expect(review).not.toHaveBeenCalled();
  });

  it('returns 503 for a retryable review result so Ticket Bot retains its cursor', async () => {
    const review = vi.fn(async () =>
      runtimeResult('policy_source_unavailable', true));
    const ingress = new TicketEventIngress(SECRET, { review });
    const signed = signedBody(event());

    const response = await ingress.handle(signed.raw, signed.signature);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      accepted: false,
      eventType: 'ticket.message',
      reviewStatus: 'policy_source_unavailable',
      retryable: true,
    });
  });

  it('converts reviewer exceptions into a generic retryable response', async () => {
    const review = vi.fn(async () => {
      throw new Error('private downstream secret detail');
    });
    const ingress = new TicketEventIngress(SECRET, { review });
    const signed = signedBody(event());

    const response = await ingress.handle(signed.raw, signed.signature);

    expect(response).toEqual({
      status: 503,
      body: {
        accepted: false,
        eventType: 'ticket.message',
        reviewStatus: 'evidence_runtime_unavailable',
        retryable: true,
      },
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('private downstream secret detail');
  });
});
