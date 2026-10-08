/**
 * @enthusia/integration-ticket-bot — ticket event consumption (W14).
 *
 * Spec: MASTER-SPECIFICATION.md §20 (Ticket Bot exposes service APIs/events).
 *
 * Enthusia AI consumes ticket lifecycle events (created, updated, closed,
 * ...) published by the Ticket Bot. It never emits lifecycle events
 * itself: event flow is one-directional, Ticket Bot → Enthusia AI.
 *
 * Two ingress paths are supported:
 *   1. `parseTicketEvent` — validate + normalize a raw event payload
 *      (e.g. from a webhook delivery or a queue consumer).
 *   2. `TicketEventRouter` — fan validated events out to subscribers.
 *
 * Payload validation rejects malformed events before they reach agent
 * reasoning (garbage-in guard).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ValidationError } from '@enthusia/contracts';
import type { TicketParticipant, TicketStatus } from './types.js';
import { TICKET_STATUSES } from './types.js';
import {
  InMemoryTicketEventDeduplicationStore,
  ticketEventDeduplicationKey,
} from './event-dedup.js';
import type { TicketEventDeduplicationStore } from './event-dedup.js';

/** Event types the Ticket Bot publishes and Enthusia AI consumes. */
export type TicketEventType =
  | 'ticket.created'
  | 'ticket.updated'
  | 'ticket.closed'
  | 'ticket.reopened'
  | 'ticket.message'
  | 'ticket.escalated'
  | 'action.request.accepted'
  | 'action.request.rejected';

export const TICKET_EVENT_TYPES: readonly TicketEventType[] = [
  'ticket.created',
  'ticket.updated',
  'ticket.closed',
  'ticket.reopened',
  'ticket.message',
  'ticket.escalated',
  'action.request.accepted',
  'action.request.rejected',
] as const;

/** Lifecycle events Enthusia AI should treat as "ticket state changed". */
export const TICKET_STATE_EVENT_TYPES: readonly TicketEventType[] = [
  'ticket.created',
  'ticket.updated',
  'ticket.closed',
  'ticket.reopened',
  'ticket.escalated',
] as const;

const participantSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['player', 'staff', 'system']),
  displayName: z.string().optional(),
});

const baseEventSchema = z.object({
  type: z.enum(TICKET_EVENT_TYPES),
  event_id: z.string().min(1),
  ticket_id: z.string().min(1),
  occurred_at: z.string().min(1),
  source: z.literal('ticket-bot'),
  actor: participantSchema.optional(),
});

/** Per-type payload schemas. */
const eventPayloadSchemas: Record<TicketEventType, z.ZodTypeAny> = {
  'ticket.created': z.object({
    category: z.string().min(1),
    subject: z.string().min(1),
    owner: participantSchema,
  }),
  'ticket.updated': z.object({
    status: z.enum(TICKET_STATUSES),
    changed_fields: z.array(z.string()).optional(),
  }),
  'ticket.closed': z.object({
    closed_by: participantSchema.optional(),
    close_reason: z.string().optional(),
  }),
  'ticket.reopened': z.object({
    reopened_by: participantSchema.optional(),
    reopen_reason: z.string().optional(),
  }),
  'ticket.message': z.object({
    message_id: z.string().min(1),
    author: participantSchema,
    body: z.string().max(20_000),
  }),
  'ticket.escalated': z.object({
    escalated_by: participantSchema.optional(),
    assignee: participantSchema.optional(),
    escalation_reason: z.string().optional(),
  }),
  'action.request.accepted': z.object({
    request_id: z.string().min(1),
    action: z.string().min(1),
  }),
  'action.request.rejected': z.object({
    request_id: z.string().min(1),
    action: z.string().min(1),
    rejection_reason: z.string().min(1),
  }),
};

const rawEventSchema = z
  .object({
    type: z.enum(TICKET_EVENT_TYPES),
    event_id: z.string().min(1),
    ticket_id: z.string().min(1),
    occurred_at: z.string().min(1),
    source: z.literal('ticket-bot'),
    actor: participantSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .superRefine((value, ctx) => {
    const payloadSchema = eventPayloadSchemas[value.type];
    const parsed = payloadSchema.safeParse(value.payload);
    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        message: `invalid payload for event type ${value.type}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      });
    }
  });

/** A validated ticket lifecycle event consumed from the Ticket Bot. */
export interface TicketEvent {
  type: TicketEventType;
  eventId: string;
  ticketId: string;
  occurredAt: string;
  source: 'ticket-bot';
  actor?: TicketParticipant;
  payload: Record<string, unknown>;
}

/** Type guard: is this a ticket-state-change event (vs. message/action events)? */
export function isTicketStateEvent(event: TicketEvent): boolean {
  return (TICKET_STATE_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * Validate and normalize a raw event payload into a {@link TicketEvent}.
 *
 * Throws ValidationError for unknown types, missing fields, or per-type
 * payload mismatches. Never mutates the input.
 */
export function parseTicketEvent(raw: unknown): TicketEvent {
  const parsed = rawEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid ticket event: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const v = parsed.data;
  // Normalize the zod-inferred actor shape to the exact TicketParticipant
  // type (exactOptionalPropertyTypes disallows explicit undefined values).
  const actor: TicketParticipant | undefined =
    v.actor === undefined
      ? undefined
      : {
          id: v.actor.id,
          kind: v.actor.kind,
          ...(v.actor.displayName !== undefined
            ? { displayName: v.actor.displayName }
            : {}),
        };
  return {
    type: v.type,
    eventId: v.event_id,
    ticketId: v.ticket_id,
    occurredAt: v.occurred_at,
    source: v.source,
    ...(actor !== undefined ? { actor } : {}),
    payload: v.payload,
  };
}

export type TicketEventHandler = (event: TicketEvent) => void | Promise<void>;

export interface TicketEventRouterOptions {
  onHandlerError?: (err: unknown, event: TicketEvent) => void;
  onDuplicate?: (event: TicketEvent) => void;
  /**
   * Default is bounded process-local deduplication. Production webhook ingress
   * should inject a durable store with an atomic uniqueness claim.
   * Pass null only for trusted replay tooling that intentionally re-dispatches.
   */
  deduplicationStore?: TicketEventDeduplicationStore | null;
}

/**
 * Fan-out router for validated ticket events.
 *
 * Ingress is idempotent by event_id when a deduplication store is enabled.
 * A throwing handler does not break other handlers; handler failures are
 * surfaced through `onHandlerError` and never converted into lifecycle truth.
 */
export class TicketEventRouter {
  private readonly handlers = new Map<string, Set<TicketEventHandler>>();
  private readonly onHandlerError: (err: unknown, event: TicketEvent) => void;
  private readonly onDuplicate: (event: TicketEvent) => void;
  private readonly deduplicationStore: TicketEventDeduplicationStore | null;
  private duplicateCount = 0;

  constructor(options: TicketEventRouterOptions = {}) {
    this.onHandlerError = options.onHandlerError ?? defaultHandlerError;
    this.onDuplicate = options.onDuplicate ?? (() => undefined);
    this.deduplicationStore =
      options.deduplicationStore === undefined
        ? new InMemoryTicketEventDeduplicationStore()
        : options.deduplicationStore;
  }

  /** Subscribe to one event type, or '*' for every event. */
  subscribe(type: TicketEventType | '*', handler: TicketEventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => this.unsubscribe(type, handler);
  }

  unsubscribe(type: TicketEventType | '*', handler: TicketEventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  /** Dispatch an already-validated event. Callers bypassing ingest own deduplication. */
  async dispatch(event: TicketEvent): Promise<void> {
    const targets = [
      ...(this.handlers.get(event.type) ?? []),
      ...(this.handlers.get('*') ?? []),
    ];
    for (const handler of targets) await this.runHandler(handler, event);
  }

  /** Parse, deduplicate, and dispatch one webhook/queue delivery. */
  async ingest(raw: unknown): Promise<TicketEvent> {
    const event = parseTicketEvent(raw);
    if (!(await this.claim(event))) return event;
    await this.dispatch(event);
    return event;
  }

  get subscriberCount(): number {
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }

  get duplicatesSuppressed(): number {
    return this.duplicateCount;
  }

  private async claim(event: TicketEvent): Promise<boolean> {
    if (this.deduplicationStore === null) return true;
    const firstDelivery = await this.deduplicationStore.claim(
      ticketEventDeduplicationKey(event),
    );
    if (firstDelivery) return true;
    this.duplicateCount += 1;
    this.onDuplicate(event);
    return false;
  }

  private async runHandler(
    handler: TicketEventHandler,
    event: TicketEvent,
  ): Promise<void> {
    try {
      await handler(event);
    } catch (err) {
      this.onHandlerError(err, event);
    }
  }
}

function defaultHandlerError(err: unknown): void {
  // Default: surface via console, never swallow silently.
  console.error('[ticket-bot] event handler failed:', err);
}

/**
 * Verify an HMAC-SHA256 webhook signature over the raw request body.
 *
 * `signature` is the hex digest sent by the Ticket Bot (e.g. in an
 * `X-TicketBot-Signature` header). Returns false on mismatch instead of
 * throwing, so callers can reject with 401.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

// Re-export for convenience (baseEventSchema documents the wire contract).
export { baseEventSchema };
export type { TicketStatus };
