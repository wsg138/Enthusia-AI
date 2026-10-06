/**
 * @enthusia/integration-ticket-bot — ticket domain types (W14).
 *
 * Spec: MASTER-SPECIFICATION.md §6.2 (ticket support), §20 (Ticket Bot
 * separation and migration).
 *
 * Ownership note: the Ticket Bot owns ticket lifecycle state (creation,
 * permissions, channel lifecycle, close confirmation, transcripts,
 * archiving, persistence). Enthusia AI only *reads* ticket state and
 * *requests* lifecycle actions through the typed client in client.ts.
 * The Ticket Bot validates and executes every request.
 */

/** Lifecycle states owned by the Ticket Bot. Enthusia AI never sets these. */
export type TicketStatus = 'open' | 'pending' | 'on_hold' | 'resolved' | 'closed';

export const TICKET_STATUSES: readonly TicketStatus[] = [
  'open',
  'pending',
  'on_hold',
  'resolved',
  'closed',
] as const;

/** Ticket categories known to the Ticket Bot. */
export type TicketCategory =
  | 'support'
  | 'report'
  | 'appeal'
  | 'bug'
  | 'application'
  | 'other';

export const TICKET_CATEGORIES: readonly TicketCategory[] = [
  'support',
  'report',
  'appeal',
  'bug',
  'application',
  'other',
] as const;

export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

/** A person (or system component) participating in a ticket. */
export interface TicketParticipant {
  /** Stable participant id (player UUID, staff id, or system component name). */
  id: string;
  kind: 'player' | 'staff' | 'system';
  displayName?: string;
}

/** A single message in a ticket transcript (Ticket Bot is the transcript authority). */
export interface TicketMessage {
  id: string;
  ticketId: string;
  author: TicketParticipant;
  /** Message body. May contain player-visible text; never secrets (§5.5). */
  body: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/** Ticket state snapshot as reported by the Ticket Bot (read-only for AI). */
export interface Ticket {
  id: string;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  /** The player who opened the ticket. */
  owner: TicketParticipant;
  /** Staff currently assigned. */
  assignees: TicketParticipant[];
  /** Discord channel id hosting the ticket, when known. */
  channelId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  messageCount: number;
  /** Opaque version/etag from the Ticket Bot for freshness provenance. */
  version?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Lifecycle actions Enthusia AI may *request*.
 *
 * Spec §20.2: AI requests — close, reopen, escalation, state transition.
 * The Ticket Bot validates permissions, state, confirmation, concurrency,
 * and transcript/archive rules before executing.
 */
export type ActionRequestKind =
  | 'close'
  | 'reopen'
  | 'escalate'
  | 'add_note'
  | 'transition';

export const ACTION_REQUEST_KINDS: readonly ActionRequestKind[] = [
  'close',
  'reopen',
  'escalate',
  'add_note',
  'transition',
] as const;

export interface TicketBotCapabilities {
  service: 'enthusia-support-bot';
  api: 'ticket-lifecycle';
  contractVersion: 'w14-v1';
  reads: Array<
    | 'tickets.list'
    | 'tickets.get'
    | 'tickets.messages'
    | 'tickets.participants'
    | 'actions.get'
  >;
  actions: ActionRequestKind[];
  eventDelivery: 'optional-hmac-webhook';
}

/** Parameters accompanying an action request (all optional; bot validates). */
export interface ActionRequestParameters {
  /** Desired target state for `transition` requests. */
  targetStatus?: TicketStatus;
  /** Staff id to hand the ticket to, for `escalate`. */
  assigneeId?: string;
  /** Note text for `add_note` requests. */
  note?: string;
  /** Caller-controlled extra context for the audit log; no secrets. */
  extra?: Record<string, unknown>;
}

/** An action request submitted to the Ticket Bot (input side). */
export interface ActionRequestInput {
  action: ActionRequestKind;
  /** Human-readable justification recorded in the audit log. */
  reason: string;
  parameters?: ActionRequestParameters;
  /**
   * Request correlation ID. The client generates one when omitted so the
   * request can be tracked end-to-end and retried idempotently.
   */
  correlationId?: string;
}

/** Lifecycle of a submitted action request, tracked by the Ticket Bot. */
export type ActionRequestStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'expired';

/** An action request as tracked by the Ticket Bot (output side). */
export interface ActionRequestResult {
  requestId: string;
  ticketId: string;
  action: ActionRequestKind;
  status: ActionRequestStatus;
  /** Rejection/supersede explanation from the Ticket Bot, when present. */
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

/** Generic paginated envelope returned by Ticket Bot list endpoints. */
export interface Paginated<T> {
  items: T[];
  /** Opaque cursor for the next page; absent when this is the last page. */
  nextCursor?: string;
  total?: number;
}

/** Options for ticket listing. */
export interface ListTicketsOptions {
  status?: TicketStatus;
  ownerId?: string;
  assigneeId?: string;
  category?: TicketCategory;
  limit?: number;
  cursor?: string;
}

/** Options for message listing. */
export interface ListMessagesOptions {
  limit?: number;
  cursor?: string;
}

/** Options for the combined context fetch used by the context adapter. */
export interface TicketContextFetchOptions {
  /** Maximum transcript messages to include (default 20, max 100). */
  maxMessages?: number;
  /** Include participants list (default true). */
  includeParticipants?: boolean;
}

/** Ticket + related data fetched together for agent reasoning. */
export interface TicketContextBundle {
  ticket: Ticket;
  messages: TicketMessage[];
  participants: TicketParticipant[];
  /** ISO-8601 timestamp when this bundle was assembled. */
  fetchedAt: string;
}
