/**
 * W14 tests — Ticket Bot integration.
 *
 * All tests run against a mock Ticket Bot API (node:http server); NO real
 * Ticket Bot connection is ever made. The mock records every request so the
 * no-mutation invariant is pinned: the client may only ever issue
 * allowlisted reads and action requests — never PUT/PATCH/DELETE, never
 * POST outside /v1/tickets/{id}/actions/request.
 */
import { createHmac } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';

import {
  AI_REQUESTED_BY,
  TicketBotClient,
  assertAllowedRequest,
  TICKET_BOT_REQUEST_ALLOWLIST,
} from '../src/client.js';
import {
  TicketEvidenceClient,
  assertAllowedEvidenceRequest,
  TICKET_EVIDENCE_REQUEST_ALLOWLIST,
} from '../src/evidence-client.js';
import { ticketToAgentContext } from '../src/context.js';
import { ticketReportTarget } from '../src/report-target.js';
import {
  TicketEventRouter,
  parseTicketEvent,
  verifyWebhookSignature,
} from '../src/events.js';
import { createTicketTools } from '../src/tools.js';
import type {
  ActionRequestResult,
  Paginated,
  Ticket,
  TicketContextBundle,
  TicketMessage,
  TicketParticipant,
} from '../src/types.js';

// ----------------------------------------------------------------------
// Mock Ticket Bot API
// ----------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
  body: unknown;
}

const recorded: RecordedRequest[] = [];

const OWNER: TicketParticipant = {
  id: 'player-uuid-1',
  kind: 'player',
  displayName: 'TestPlayer',
};
const STAFF: TicketParticipant = {
  id: 'staff-42',
  kind: 'staff',
  displayName: 'ModAlex',
};

const TICKET: Ticket = {
  id: 'T-1234',
  category: 'support',
  subject: 'Cannot claim land',
  status: 'open',
  priority: 'normal',
  owner: OWNER,
  assignees: [],
  channelId: 'chan-99',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T12:00:00.000Z',
  messageCount: 2,
  version: 'v7',
};

const MESSAGES: TicketMessage[] = [
  {
    id: 'm-1',
    ticketId: 'T-1234',
    author: OWNER,
    body: 'My land claim disappeared after the restart.',
    createdAt: '2026-10-01T10:01:00.000Z',
    attachments: [
      {
        id: '120000000000000001',
        name: 'claim-evidence.png',
        contentType: 'image/png',
        size: 524288,
        source: 'discord',
      },
    ],
  },
  {
    id: 'm-2',
    ticketId: 'T-1234',
    author: STAFF,
    body: 'Looking into it — checking the claim logs now.',
    createdAt: '2026-10-01T10:05:00.000Z',
  },
];

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => {
    raw += chunk.toString();
  });
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const authHeader = req.headers.authorization;
    recorded.push({
      method: req.method ?? '',
      path: url.pathname,
      ...(typeof authHeader === 'string' ? { authorization: authHeader } : {}),
      body: raw ? JSON.parse(raw) : undefined,
    });

    if (url.pathname === '/v1/evidence/capabilities' && req.method === 'GET') {
      return json(res, 200, {
        service: 'enthusia-support-bot',
        api: 'ticket-evidence',
        contractVersion: 'evidence-v1',
        reads: ['attachment.image'],
        maxImageBytes: 8 * 1024 * 1024,
      });
    }
    if (
      url.pathname ===
        '/v1/tickets/T-1234/messages/m-1/attachments/120000000000000001/image' &&
      req.method === 'GET'
    ) {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Enthusia-Ticket-Id': '1234',
        'X-Enthusia-Message-Id': 'm-1',
        'X-Enthusia-Attachment-Id': '120000000000000001',
        'X-Enthusia-Content-Sha256':
          '0f4636c78f65d3639ece5a064b5ae753e3408614a14fb18ab4d7540d2c248543',
      });
      return res.end(bytes);
    }
    if (url.pathname === '/v1/capabilities' && req.method === 'GET') {
      return json(res, 200, {
        service: 'enthusia-support-bot',
        api: 'ticket-lifecycle',
        contractVersion: 'w14-v1',
        reads: [
          'tickets.list',
          'tickets.get',
          'tickets.messages',
          'tickets.participants',
          'actions.get',
        ],
        actions: ['close', 'reopen', 'escalate', 'add_note', 'transition'],
        eventDelivery: 'optional-hmac-webhook',
      });
    }
    if (url.pathname === '/v1/tickets/T-1234' && req.method === 'GET') {
      return json(res, 200, TICKET);
    }
    if (url.pathname === '/v1/tickets/T-1234/messages' && req.method === 'GET') {
      const page: Paginated<TicketMessage> = { items: MESSAGES };
      return json(res, 200, page);
    }
    if (url.pathname === '/v1/tickets/T-1234/participants' && req.method === 'GET') {
      return json(res, 200, [OWNER, STAFF]);
    }
    if (url.pathname === '/v1/tickets' && req.method === 'GET') {
      const page: Paginated<Ticket> = { items: [TICKET], total: 1 };
      return json(res, 200, page);
    }
    if (url.pathname === '/v1/tickets/T-1234/actions/request' && req.method === 'POST') {
      const incoming = JSON.parse(raw) as {
        action: string;
        reason: string;
        requested_by: string;
        correlation_id: string;
        parameters: Record<string, unknown>;
      };
      const result: ActionRequestResult = {
        requestId: 'ar-1',
        ticketId: 'T-1234',
        action: incoming.action as ActionRequestResult['action'],
        status: 'accepted',
        createdAt: '2026-10-03T12:00:00.000Z',
        updatedAt: '2026-10-03T12:00:00.000Z',
      };
      return json(res, 200, result);
    }
    if (url.pathname === '/v1/actions/requests/ar-1' && req.method === 'GET') {
      const result: ActionRequestResult = {
        requestId: 'ar-1',
        ticketId: 'T-1234',
        action: 'close',
        status: 'accepted',
        createdAt: '2026-10-03T12:00:00.000Z',
        updatedAt: '2026-10-03T12:01:00.000Z',
      };
      return json(res, 200, result);
    }
    if (url.pathname === '/v1/tickets/NOPE' && req.method === 'GET') {
      return json(res, 404, { error: 'ticket not found' });
    }
    return json(res, 404, { error: 'unknown route' });
  });
});

let baseUrl = '';
const API_KEY = ['synthetic', 'ticket', 'credential', '001'].join('-');

function makeClient(): TicketBotClient {
  return new TicketBotClient({ baseUrl, apiKey: API_KEY, timeoutMs: 5_000 });
}

function makeEvidenceClient(): TicketEvidenceClient {
  return new TicketEvidenceClient({
    baseUrl,
    apiKey: API_KEY,
    timeoutMs: 5_000,
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// ----------------------------------------------------------------------
// Client: reads
// ----------------------------------------------------------------------

describe('TicketBotClient evidence capabilities', () => {
  it('reads the separate ticket-evidence capability contract', async () => {
    const capabilities = await makeEvidenceClient().getCapabilities();
    expect(capabilities).toEqual({
      service: 'enthusia-support-bot',
      api: 'ticket-evidence',
      contractVersion: 'evidence-v1',
      reads: ['attachment.image'],
      maxImageBytes: 8 * 1024 * 1024,
    });
  });

  it('fetches image bytes only through ticket/message/attachment provenance ids', async () => {
    const evidence = await makeEvidenceClient().getImageEvidence(
      'T-1234',
      'm-1',
      '120000000000000001',
    );
    expect(evidence).toMatchObject({
      ticketId: 'T-1234',
      messageId: 'm-1',
      attachmentId: '120000000000000001',
      contentType: 'image/png',
      size: 4,
      sha256:
        '0f4636c78f65d3639ece5a064b5ae753e3408614a14fb18ab4d7540d2c248543',
    });
    expect([...evidence.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('rejects image evidence when the provenance hash does not match the bytes', async () => {
    const client = new TicketEvidenceClient({
      baseUrl,
      apiKey: API_KEY,
      timeoutMs: 5_000,
      fetchImpl: async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith('/v1/evidence/capabilities')) {
          return new Response(JSON.stringify({
            service: 'enthusia-support-bot',
            api: 'ticket-evidence',
            contractVersion: 'evidence-v1',
            reads: ['attachment.image'],
            maxImageBytes: 1024,
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': '3',
            'X-Enthusia-Ticket-Id': '1234',
            'X-Enthusia-Message-Id': 'm-1',
            'X-Enthusia-Attachment-Id': '120000000000000001',
            'X-Enthusia-Content-Sha256':
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        });
      },
    });

    await expect(
      client.getImageEvidence(
        'T-1234',
        'm-1',
        '120000000000000001',
      ),
    ).rejects.toThrow(/content hash did not match/);
  });
});

describe('TicketBotClient capabilities', () => {
  it('reads and validates the deployed W14 capability contract', async () => {
    const capabilities = await makeClient().getCapabilities();
    expect(capabilities.contractVersion).toBe('w14-v1');
    expect(capabilities.actions).toContain('close');
    expect(capabilities.reads).toContain('tickets.get');
  });

  it('rejects an incompatible deployed capability contract', async () => {
    const client = new TicketBotClient({
      baseUrl,
      apiKey: API_KEY,
      timeoutMs: 5_000,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            service: 'enthusia-support-bot',
            api: 'ticket-lifecycle',
            contractVersion: 'future-v2',
            reads: [],
            actions: [],
            eventDelivery: 'optional-hmac-webhook',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    await expect(client.getCapabilities()).rejects.toThrow(/incompatible capability contract/);
  });
});

describe('ticket report target metadata', () => {
  it('accepts only the bounded report target projection', () => {
    expect(ticketReportTarget({
      ...TICKET,
      category: 'report',
      metadata: {
        reportTarget: {
          kind: 'minecraft_username',
          value: 'Bad_Player',
        },
      },
    })).toEqual({
      kind: 'minecraft_username',
      value: 'Bad_Player',
    });
  });

  it('fails closed for missing, malformed, or non-report metadata', () => {
    expect(ticketReportTarget(TICKET)).toBeNull();
    expect(ticketReportTarget({
      ...TICKET,
      category: 'report',
      metadata: {
        reportTarget: {
          kind: 'minecraft_username',
          value: '../bad',
        },
      },
    })).toBeNull();
    expect(ticketReportTarget({
      ...TICKET,
      category: 'support',
      metadata: {
        reportTarget: {
          kind: 'minecraft_username',
          value: 'ValidName',
        },
      },
    })).toBeNull();
  });
});

describe('TicketBotClient reads', () => {
  it('fetches a ticket with typed fields', async () => {
    const ticket = await makeClient().getTicket('T-1234');
    expect(ticket.id).toBe('T-1234');
    expect(ticket.status).toBe('open');
    expect(ticket.owner.displayName).toBe('TestPlayer');
    expect(ticket.version).toBe('v7');
  });

  it('fetches a full context bundle (ticket + messages + participants)', async () => {
    const bundle = await makeClient().getTicketContext('T-1234', { maxMessages: 10 });
    expect(bundle.ticket.id).toBe('T-1234');
    expect(bundle.messages).toHaveLength(2);
    expect(bundle.messages[0]?.attachments).toEqual([
      {
        id: '120000000000000001',
        name: 'claim-evidence.png',
        contentType: 'image/png',
        size: 524288,
        source: 'discord',
      },
    ]);
    expect(bundle.participants).toHaveLength(2);
    expect(bundle.fetchedAt).toBeTruthy();
  });

  it('lists tickets', async () => {
    const page = await makeClient().listTickets({ status: 'open' });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it('maps 404 to NotFoundError with code NOT_FOUND', async () => {
    const err = await makeClient()
      .getTicket('NOPE')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('NOT_FOUND');
  });

  it('sends the API key as a Bearer token', async () => {
    recorded.length = 0;
    await makeClient().getTicket('T-1234');
    expect(recorded[0]?.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('never leaks the API key in thrown errors', async () => {
    const broken = new TicketBotClient({
      baseUrl: 'http://127.0.0.1:1', // nothing listening -> connection refused
      apiKey: API_KEY,
      timeoutMs: 2_000,
    });
    const err = await broken.getTicket('T-1234').catch((e: unknown) => e);
    const serialized = JSON.stringify(err);
    expect(serialized).not.toContain(API_KEY);
  });
});

// ----------------------------------------------------------------------
// Client: action requests (NOT mutations)
// ----------------------------------------------------------------------

describe('TicketBotClient action requests', () => {
  it('requestClose posts an action REQUEST to the request endpoint', async () => {
    recorded.length = 0;
    const result = await makeClient().requestClose(
      'T-1234',
      'Issue resolved; claim restored.',
      'trace-abc',
    );
    expect(result.requestId).toBe('ar-1');
    expect(result.action).toBe('close');
    expect(result.status).toBe('accepted');

    const post = recorded.find((r) => r.method === 'POST');
    expect(post?.path).toBe('/v1/tickets/T-1234/actions/request');
    expect(post?.body).toMatchObject({
      action: 'close',
      reason: 'Issue resolved; claim restored.',
      requested_by: AI_REQUESTED_BY,
      correlation_id: 'trace-abc',
    });
  });

  it('requestEscalation includes assignee in parameters', async () => {
    recorded.length = 0;
    await makeClient().requestEscalation('T-1234', 'Needs senior review.', {
      assigneeId: 'staff-42',
    });
    const post = recorded.find((r) => r.method === 'POST');
    expect(post?.body).toMatchObject({
      action: 'escalate',
      parameters: { assigneeId: 'staff-42' },
    });
  });

  it('requestReopen and requestAddNote flow through the same request endpoint', async () => {
    recorded.length = 0;
    await makeClient().requestReopen('T-1234', 'Player reports recurrence.');
    await makeClient().requestAddNote('T-1234', 'Claim logs checked.', 'Audit trail.');
    const posts = recorded.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.path).toBe('/v1/tickets/T-1234/actions/request');
    }
  });

  it('generates a correlation id when none is supplied', async () => {
    recorded.length = 0;
    await makeClient().requestClose('T-1234', 'Resolved.');
    const post = recorded.find((r) => r.method === 'POST');
    const body = post?.body as { correlation_id?: string };
    expect(typeof body.correlation_id).toBe('string');
    expect(body.correlation_id?.length).toBeGreaterThan(0);
  });

  it('rejects action requests with an empty reason', async () => {
    const err = await makeClient()
      .requestClose('T-1234', '   ')
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('VALIDATION_ERROR');
  });

  it('polls action request status', async () => {
    const result = await makeClient().getActionRequest('ar-1');
    expect(result.requestId).toBe('ar-1');
    expect(result.status).toBe('accepted');
  });
});

// ----------------------------------------------------------------------
// No-mutation invariant
// ----------------------------------------------------------------------

describe('no-mutation invariant', () => {
  it('allowlist contains no PUT/PATCH/DELETE target', () => {
    const mutating = TICKET_BOT_REQUEST_ALLOWLIST.filter((t) =>
      ['PUT', 'PATCH', 'DELETE'].includes(t.method),
    );
    expect(mutating).toHaveLength(0);
  });

  it('allowlist exposes POST only on the action-request endpoint', () => {
    const posts = TICKET_BOT_REQUEST_ALLOWLIST.filter((t) => t.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    for (const target of posts) {
      expect(target.path.test('/v1/tickets/T-9/actions/request')).toBe(true);
      expect(target.path.test('/v1/tickets/T-9')).toBe(false);
      expect(target.path.test('/v1/tickets/T-9/messages')).toBe(false);
    }
  });

  it('assertAllowedRequest rejects every mutation-shaped target', () => {
    const forbidden: Array<[string, string]> = [
      ['PUT', '/v1/tickets/T-1234'],
      ['PATCH', '/v1/tickets/T-1234'],
      ['DELETE', '/v1/tickets/T-1234'],
      ['POST', '/v1/tickets/T-1234/close'],
      ['POST', '/v1/tickets/T-1234'],
      ['POST', '/v1/tickets'],
      ['DELETE', '/v1/actions/requests/ar-1'],
      ['GET', '/v1/admin/tickets'],
      ['GET', '/v1/tickets/T-1234/actions/request'],
    ];
    for (const [method, path] of forbidden) {
      expect(() => assertAllowedRequest(method, path), `${method} ${path}`).toThrow(
        /refuses/,
      );
    }
  });

  it('assertAllowedRequest accepts every client-issued target', () => {
    const allowed: Array<[string, string]> = [
      ['GET', '/v1/capabilities'],
      ['GET', '/v1/tickets'],
      ['GET', '/v1/tickets/T-1234'],
      ['GET', '/v1/tickets/T-1234/messages'],
      ['GET', '/v1/tickets/T-1234/participants'],
      ['POST', '/v1/tickets/T-1234/actions/request'],
      ['GET', '/v1/actions/requests/ar-1'],
    ];
    for (const [method, path] of allowed) {
      expect(() => assertAllowedRequest(method, path), `${method} ${path}`).not.toThrow();
    }
  });

  it('exercising the whole client never issues a mutation-shaped request', async () => {
    recorded.length = 0;
    const client = makeClient();
    await client.getTicket('T-1234');
    await client.listTickets({ status: 'open', limit: 5 });
    await client.getTicketMessages('T-1234', { limit: 10 });
    await client.getTicketParticipants('T-1234');
    await client.getTicketContext('T-1234');
    await client.requestClose('T-1234', 'Resolved.');
    await client.requestReopen('T-1234', 'Recurrence reported.');
    await client.requestEscalation('T-1234', 'Needs senior.', { assigneeId: 'staff-42' });
    await client.requestAddNote('T-1234', 'Note text.', 'Audit.');
    await client.getActionRequest('ar-1');

    expect(recorded.length).toBeGreaterThan(0);
    for (const r of recorded) {
      expect(['GET', 'POST']).toContain(r.method);
      expect(() => assertAllowedRequest(r.method, r.path)).not.toThrow();
      // Belt and braces: no mutation verb may ever appear on the wire.
      expect(['PUT', 'PATCH', 'DELETE']).not.toContain(r.method);
      if (r.method === 'POST') {
        expect(r.path).toBe('/v1/tickets/T-1234/actions/request');
      }
    }
  });
});

describe('ticket evidence read-only invariant', () => {
  it('allowlist contains GET-only bounded evidence targets', () => {
    expect(TICKET_EVIDENCE_REQUEST_ALLOWLIST).toHaveLength(2);
    for (const target of TICKET_EVIDENCE_REQUEST_ALLOWLIST) {
      expect(target.method).toBe('GET');
    }
    expect(() =>
      assertAllowedEvidenceRequest('GET', '/v1/evidence/capabilities'),
    ).not.toThrow();
    expect(() =>
      assertAllowedEvidenceRequest(
        'GET',
        '/v1/tickets/T-1234/messages/m-1/attachments/120000000000000001/image',
      ),
    ).not.toThrow();
  });

  it('rejects arbitrary URLs, mutation verbs, and unrelated ticket paths', () => {
    const forbidden: Array<[string, string]> = [
      ['POST', '/v1/evidence/capabilities'],
      ['GET', 'https://cdn.discordapp.com/attachments/1/2/evidence.png'],
      ['GET', '/v1/tickets/T-1234/messages/m-1'],
      ['DELETE', '/v1/tickets/T-1234/messages/m-1/attachments/1/image'],
    ];
    for (const [method, path] of forbidden) {
      expect(() => assertAllowedEvidenceRequest(method, path)).toThrow(/refuses/);
    }
  });

  it('exercising the evidence client issues reads only', async () => {
    recorded.length = 0;
    const client = makeEvidenceClient();
    await client.getCapabilities();
    await client.getImageEvidence(
      'T-1234',
      'm-1',
      '120000000000000001',
    );
    expect(recorded.length).toBeGreaterThan(0);
    for (const request of recorded) {
      expect(request.method).toBe('GET');
      expect(() =>
        assertAllowedEvidenceRequest(request.method, request.path),
      ).not.toThrow();
    }
  });
});

// ----------------------------------------------------------------------
// Events
// ----------------------------------------------------------------------

describe('ticket events', () => {
  it('parses a valid ticket.created event', () => {
    const event = parseTicketEvent({
      type: 'ticket.created',
      event_id: 'e-1',
      ticket_id: 'T-1234',
      occurred_at: '2026-10-03T10:00:00.000Z',
      source: 'ticket-bot',
      payload: {
        category: 'support',
        subject: 'Cannot claim land',
        owner: { id: 'player-uuid-1', kind: 'player' },
      },
    });
    expect(event.type).toBe('ticket.created');
    expect(event.eventId).toBe('e-1');
    expect(event.source).toBe('ticket-bot');
  });

  it('rejects events with an unknown type', () => {
    expect(() =>
      parseTicketEvent({
        type: 'ticket.nuked',
        event_id: 'e-2',
        ticket_id: 'T-1234',
        occurred_at: '2026-10-03T10:00:00.000Z',
        source: 'ticket-bot',
        payload: {},
      }),
    ).toThrow(/Invalid ticket event/);
  });

  it('rejects events with a per-type payload mismatch', () => {
    expect(() =>
      parseTicketEvent({
        type: 'ticket.message',
        event_id: 'e-3',
        ticket_id: 'T-1234',
        occurred_at: '2026-10-03T10:00:00.000Z',
        source: 'ticket-bot',
        payload: { message_id: 'm-9' }, // missing author + body
      }),
    ).toThrow(/invalid payload/);
  });

  it('routes events to typed and wildcard subscribers', async () => {
    const router = new TicketEventRouter();
    const seen: string[] = [];
    router.subscribe('ticket.closed', (e) => {
      seen.push(`typed:${e.ticketId}`);
    });
    router.subscribe('*', (e) => {
      seen.push(`wild:${e.type}`);
    });
    await router.ingest({
      type: 'ticket.closed',
      event_id: 'e-4',
      ticket_id: 'T-1234',
      occurred_at: '2026-10-03T10:00:00.000Z',
      source: 'ticket-bot',
      payload: { close_reason: 'resolved' },
    });
    expect(seen).toContain('typed:T-1234');
    expect(seen).toContain('wild:ticket.closed');
  });

  it('unsubscribe stops delivery; a throwing handler does not break others', async () => {
    const errors: unknown[] = [];
    const router = new TicketEventRouter({
      onHandlerError: (err) => errors.push(err),
    });
    const seen: string[] = [];
    const bad = () => {
      throw new Error('boom');
    };
    const good = () => {
      seen.push('good');
    };
    const off = router.subscribe('ticket.updated', good);
    router.subscribe('ticket.updated', bad);
    await router.ingest({
      type: 'ticket.updated',
      event_id: 'e-5',
      ticket_id: 'T-1234',
      occurred_at: '2026-10-03T10:00:00.000Z',
      source: 'ticket-bot',
      payload: { status: 'pending' },
    });
    expect(seen).toEqual(['good']);
    expect(errors).toHaveLength(1);
    off();
    expect(router.subscriberCount).toBe(1);
  });

  it('verifies webhook signatures with timing-safe comparison', () => {
    const secret = 'webhook-secret';
    const body = '{"type":"ticket.created"}';
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
    expect(verifyWebhookSignature(body, sig, 'wrong-secret')).toBe(false);
    expect(verifyWebhookSignature(body, 'not-hex!!', secret)).toBe(false);
    expect(verifyWebhookSignature(body, sig, '')).toBe(false);
  });
});

// ----------------------------------------------------------------------
// Context adapter
// ----------------------------------------------------------------------

describe('ticket context adapter', () => {
  const bundle: TicketContextBundle = {
    ticket: TICKET,
    messages: MESSAGES,
    participants: [OWNER, STAFF],
    fetchedAt: '2026-10-03T12:00:00.000Z',
  };

  it('builds agent context with PLAYER_SELF classification', () => {
    const ctx = ticketToAgentContext(bundle, { traceId: 'trace-1' });
    expect(ctx.ticketId).toBe('T-1234');
    expect(ctx.visibility).toBe(Visibility.PLAYER_SELF);
    expect(ctx.source).toBe('ticket-bot');
    expect(ctx.version).toBe('v7');
    expect(ctx.traceId).toBe('trace-1');
    expect(ctx.transcript).toHaveLength(2);
    expect(ctx.transcript[0]).toMatchObject({
      messageId: 'm-1',
      ticketId: 'T-1234',
      attachments: [
        {
          id: '120000000000000001',
          name: 'claim-evidence.png',
          contentType: 'image/png',
          size: 524288,
          source: 'discord',
        },
      ],
    });
    expect(ctx.transcript[1]).toMatchObject({
      messageId: 'm-2',
      ticketId: 'T-1234',
      attachments: [],
    });
    expect(ctx.totalMessages).toBe(2);
    expect(ctx.summary).toContain('T-1234');
    expect(ctx.summary).toContain('Cannot claim land');
  });

  it('truncates transcript excerpts and message bodies', () => {
    const ctx = ticketToAgentContext(bundle, {
      maxTranscriptLines: 1,
      maxBodyChars: 10,
    });
    expect(ctx.transcript).toHaveLength(1);
    // Newest message only, body truncated.
    expect(ctx.transcript[0]?.author).toBe('ModAlex');
    expect(ctx.transcript[0]?.body.length).toBeLessThanOrEqual(10 + '…[truncated]'.length);
    expect(ctx.totalMessages).toBe(2);
  });

  it('strips malformed or unexpected attachment fields before model exposure', () => {
    const unsafeBundle = {
      ...bundle,
      messages: [
        {
          ...MESSAGES[0]!,
          attachments: [
            {
              id: '120000000000000009',
              name: 'evidence.png',
              contentType: 'IMAGE/PNG',
              size: 1000,
              source: 'discord',
              url: 'https://cdn.discordapp.com/private-signed-url',
              proxyUrl: 'https://media.discordapp.net/private-signed-url',
            },
            {
              id: '../bad',
              name: 'bad.png',
              contentType: 'image/png',
              size: 1,
              source: 'discord',
            },
          ],
        },
      ] as TicketMessage[],
    };

    const ctx = ticketToAgentContext(unsafeBundle, { traceId: 'trace-safe-attachments' });
    expect(ctx.transcript[0]?.attachments).toEqual([
      {
        id: '120000000000000009',
        name: 'evidence.png',
        contentType: 'image/png',
        size: 1000,
        source: 'discord',
      },
    ]);
    expect(JSON.stringify(ctx)).not.toContain('discordapp.com');
    expect(JSON.stringify(ctx)).not.toContain('proxyUrl');
  });

  it('is a pure transformation (inputs untouched)', () => {
    const before = JSON.stringify(bundle);
    ticketToAgentContext(bundle);
    expect(JSON.stringify(bundle)).toBe(before);
  });
});

// ----------------------------------------------------------------------
// Tools
// ----------------------------------------------------------------------

describe('ticket tools', () => {
  const staffActor = { id: 'staff-42', type: 'staff' as const };
  const ctxFor = (
    ceiling: Visibility,
    actor: { id: string; type: 'player' | 'staff'; linkedUuid?: string } = staffActor,
  ) => ({
    traceId: 'trace-tools-1',
    actor,
    visibilityCeiling: ceiling,
  });

  it('exposes only the bounded W14 tools with correct metadata', () => {
    const tools = createTicketTools(makeClient());
    expect(tools.map((t) => t.meta.name).sort()).toEqual([
      'ticket.capabilities',
      'ticket.get_context',
      'ticket.request_close',
      'ticket.request_escalation',
    ]);
    for (const tool of tools) {
      expect(tool.meta.maxVisibility).toBe(Visibility.STAFF);
      if (tool.meta.name === 'ticket.capabilities') {
        expect(tool.meta.privacySensitive).toBe(false);
        expect(tool.meta.parameters.required ?? []).toEqual([]);
      } else {
        expect(tool.meta.privacySensitive).toBe(true);
        expect(tool.meta.parameters.required).toContain('ticketId');
      }
    }
  });

  it('ticket.capabilities reports the deployed contract for staff only', async () => {
    const tool = createTicketTools(makeClient()).find((item) => item.meta.name === 'ticket.capabilities')!;
    const result = await tool.execute({}, ctxFor(Visibility.STAFF));
    expect(result.error).toBeUndefined();
    expect(result.visibility).toBe(Visibility.STAFF);
    expect(result.result).toMatchObject({
      service: 'enthusia-support-bot',
      contractVersion: 'w14-v1',
    });

    const denied = await tool.execute({}, ctxFor(Visibility.PLAYER_SELF, {
      id: OWNER.id,
      type: 'player',
    }));
    expect(denied.result).toBeUndefined();
    expect(denied.error?.code).toBe('AUTHORIZATION_ERROR');
  });

  it('ticket.get_context returns a §16.2 provenance envelope', async () => {
    const tool = createTicketTools(makeClient()).find((item) => item.meta.name === 'ticket.get_context')!;
    const result = await tool.execute({ ticketId: 'T-1234' }, ctxFor(Visibility.STAFF));
    expect(result.toolName).toBe('ticket.get_context');
    expect(result.source).toBe('ticket-bot');
    expect(result.correlationId).toBe('trace-tools-1');
    expect(result.visibility).toBe(Visibility.PLAYER_SELF);
    expect(result.error).toBeUndefined();
    const payload = result.result as { ticketId?: string };
    expect(payload.ticketId).toBe('T-1234');
  });

  it('ticket.get_context allows the ticket owner at PLAYER_SELF visibility', async () => {
    const tool = createTicketTools(makeClient()).find((item) => item.meta.name === 'ticket.get_context')!;
    const result = await tool.execute(
      { ticketId: 'T-1234' },
      ctxFor(Visibility.PLAYER_SELF, { id: OWNER.id, type: 'player' }),
    );
    expect(result.error).toBeUndefined();
    expect((result.result as { ticketId?: string }).ticketId).toBe('T-1234');
  });

  it('ticket.get_context denies another player even with a sufficient ceiling', async () => {
    const tool = createTicketTools(makeClient()).find((item) => item.meta.name === 'ticket.get_context')!;
    const result = await tool.execute(
      { ticketId: 'T-1234' },
      ctxFor(Visibility.PLAYER_SELF, { id: 'other-player', type: 'player' }),
    );
    expect(result.result).toBeUndefined();
    expect(result.error?.code).toBe('AUTHORIZATION_ERROR');
    expect(result.error?.retryable).toBe(false);
  });

  it('ticket.get_context refuses a ceiling below PLAYER_SELF', async () => {
    const tool = createTicketTools(makeClient()).find((item) => item.meta.name === 'ticket.get_context')!;
    const result = await tool.execute({ ticketId: 'T-1234' }, ctxFor(Visibility.PUBLIC));
    expect(result.result).toBeUndefined();
    expect(result.error?.code).toBe('VISIBILITY_DENIED');
    expect(result.error?.retryable).toBe(false);
  });

  it('ticket.request_close submits an action request and returns the result', async () => {
    const tools = createTicketTools(makeClient());
    const tool = tools.find((t) => t.meta.name === 'ticket.request_close')!;
    const result = await tool.execute(
      { ticketId: 'T-1234', reason: 'Resolved by staff.' },
      ctxFor(Visibility.STAFF),
    );
    expect(result.error).toBeUndefined();
    const payload = result.result as ActionRequestResult;
    expect(payload.requestId).toBe('ar-1');
    expect(payload.action).toBe('close');
  });

  it('ticket lifecycle requests deny player actors before submission', async () => {
    recorded.length = 0;
    const tools = createTicketTools(makeClient());
    const tool = tools.find((t) => t.meta.name === 'ticket.request_close')!;
    const result = await tool.execute(
      { ticketId: 'T-1234', reason: 'try close' },
      ctxFor(Visibility.PLAYER_SELF, { id: OWNER.id, type: 'player' }),
    );
    expect(result.result).toBeUndefined();
    expect(result.error?.code).toBe('AUTHORIZATION_ERROR');
    expect(recorded.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('ticket.request_escalation forwards assignee and reason', async () => {
    const tools = createTicketTools(makeClient());
    const tool = tools.find((t) => t.meta.name === 'ticket.request_escalation')!;
    const result = await tool.execute(
      { ticketId: 'T-1234', reason: 'Needs senior.', assigneeId: 'staff-42' },
      ctxFor(Visibility.STAFF),
    );
    expect(result.error).toBeUndefined();
    const payload = result.result as ActionRequestResult;
    expect(payload.action).toBe('escalate');
  });

  it('tool failures surface as error envelopes (never throw)', async () => {
    const tool = createTicketTools(makeClient()).find((item) => item.meta.name === 'ticket.get_context')!;
    const result = await tool.execute({ ticketId: 'NOPE' }, ctxFor(Visibility.STAFF));
    expect(result.result).toBeUndefined();
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(result.error?.retryable).toBe(false);
  });

  it('there is deliberately no direct-mutation tool', () => {
    const names = createTicketTools(makeClient()).map((t) => t.meta.name);
    for (const name of names) {
      expect(name).not.toMatch(/^(ticket\.)?(close|delete|mutate|update|set_)/);
    }
  });
});
