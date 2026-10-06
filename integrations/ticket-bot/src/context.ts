/**
 * @enthusia/integration-ticket-bot — ticket-context adapter (W14).
 *
 * Spec: MASTER-SPECIFICATION.md §6.2 (Enthusia AI owns "ticket
 * understanding", "AI reasoning", "response generation" over ticket data),
 * §17 (visibility).
 *
 * Converts Ticket Bot read-models (Ticket, TicketMessage) into the agent
 * context the orchestrator reasons over. This is a pure transformation:
 * it performs no I/O, makes no decisions, and mutates nothing.
 *
 * Visibility: ticket contents are identity-scoped (the ticket owner and
 * staff). The adapter classifies every context it produces as
 * PLAYER_SELF; the orchestrator's visibility ceiling (§17) decides what
 * may flow back to a given actor. Staff-only detail must never be
 * downgraded here — elevation happens in the tool layer with an explicit
 * staff ceiling.
 */

import { Visibility } from '@enthusia/contracts';
import type {
  Ticket,
  TicketContextBundle,
  TicketMessage,
  TicketParticipant,
} from './types.js';

export interface TranscriptAttachment {
  id: string;
  name: string;
  contentType?: string;
  size: number;
  source: 'discord';
}

export interface TranscriptLine {
  messageId: string;
  ticketId: string;
  author: string;
  authorKind: 'player' | 'staff' | 'system';
  body: string;
  createdAt: string;
  attachments: TranscriptAttachment[];
}

/** Agent-facing context derived from a ticket bundle. */
export interface AgentTicketContext {
  /** Ticket id this context describes. */
  ticketId: string;
  subject: string;
  category: string;
  status: string;
  priority: string;
  owner: { id: string; kind: string; displayName?: string };
  assignees: Array<{ id: string; displayName?: string }>;
  /** One-paragraph synopsis for fast reasoning. */
  summary: string;
  /** Transcript excerpt, oldest → newest, truncated per options. */
  transcript: TranscriptLine[];
  /** Total messages on the ticket (transcript may be a truncated excerpt). */
  totalMessages: number;
  /** Visibility classification of this context (§17). Always PLAYER_SELF. */
  visibility: Visibility;
  /** Provenance: the Ticket Bot is the source of truth for ticket state. */
  source: 'ticket-bot';
  /** Ticket Bot version/etag for freshness, when provided. */
  version?: string;
  /** ISO-8601 timestamp when the bundle was fetched. */
  fetchedAt: string;
  /** Trace ID to propagate into downstream tool calls. */
  traceId: string;
}

export interface TicketContextAdapterOptions {
  /** Trace ID for provenance. Generated when omitted. */
  traceId?: string;
  /** Max transcript lines to include (default 20). */
  maxTranscriptLines?: number;
  /** Max characters per message body (default 2000; bodies are truncated). */
  maxBodyChars?: number;
  /** Max summary length in characters (default 600). */
  maxSummaryChars?: number;
}

const DEFAULTS = {
  maxTranscriptLines: 20,
  maxBodyChars: 2000,
  maxSummaryChars: 600,
} as const;

function participantLabel(p: TicketParticipant): string {
  return p.displayName ?? `${p.kind}:${p.id.slice(0, 8)}`;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated]`;
}

function buildSummary(
  ticket: Ticket,
  messages: TicketMessage[],
  maxChars: number,
): string {
  const parts: string[] = [];
  parts.push(
    `Ticket ${ticket.id} (${ticket.category}, ${ticket.status}, priority ${ticket.priority}): ${ticket.subject}`,
  );
  parts.push(`Opened by ${participantLabel(ticket.owner)} at ${ticket.createdAt}.`);
  if (ticket.assignees.length > 0) {
    parts.push(
      `Assigned to ${ticket.assignees.map(participantLabel).join(', ')}.`,
    );
  } else {
    parts.push('Unassigned.');
  }
  if (messages.length > 0) {
    const last = messages[messages.length - 1] as TicketMessage;
    parts.push(
      `Last message from ${participantLabel(last.author)} at ${last.createdAt}: "${truncate(last.body, 160)}"`,
    );
  } else {
    parts.push('No messages yet.');
  }
  if (ticket.status === 'closed' && ticket.closedAt) {
    parts.push(`Closed at ${ticket.closedAt}.`);
  }
  return truncate(parts.join(' '), maxChars);
}


function safeTranscriptAttachments(
  values: TicketMessage['attachments'],
): TranscriptAttachment[] {
  if (!Array.isArray(values)) return [];

  const safe: TranscriptAttachment[] = [];
  for (const value of values.slice(0, 16)) {
    if (!isSafeAttachment(value)) continue;
    safe.push({
      id: value.id,
      name: value.name,
      size: value.size,
      source: 'discord',
      ...(value.contentType !== undefined
        ? { contentType: value.contentType.toLowerCase() }
        : {}),
    });
  }
  return safe;
}

function isSafeAttachment(
  value: NonNullable<TicketMessage['attachments']>[number],
): boolean {
  if (!/^\d{1,20}$/.test(value.id)) return false;
  const name = value.name.trim();
  if (
    name.length === 0 ||
    name.length > 255 ||
    /[\r\n\0]/.test(name)
  ) {
    return false;
  }
  if (
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > 100 * 1024 * 1024
  ) {
    return false;
  }
  if (value.source !== 'discord') return false;
  if (
    value.contentType !== undefined &&
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value.contentType)
  ) {
    return false;
  }
  return true;
}

/**
 * Convert a fetched ticket bundle into agent context.
 *
 * Pure function: no I/O, no mutation of inputs, no secrets in output.
 */
export function ticketToAgentContext(
  bundle: TicketContextBundle,
  options: TicketContextAdapterOptions = {},
): AgentTicketContext {
  const maxTranscriptLines =
    options.maxTranscriptLines ?? DEFAULTS.maxTranscriptLines;
  const maxBodyChars = options.maxBodyChars ?? DEFAULTS.maxBodyChars;
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULTS.maxSummaryChars;
  const traceId =
    options.traceId ??
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `ctx-${Date.now().toString(36)}`);

  const { ticket } = bundle;
  const excerpt = bundle.messages.slice(-Math.max(maxTranscriptLines, 1));
  const transcript: TranscriptLine[] = excerpt.map((m) => ({
    messageId: m.id,
    ticketId: m.ticketId,
    author: participantLabel(m.author),
    authorKind: m.author.kind,
    body: truncate(m.body, maxBodyChars),
    createdAt: m.createdAt,
    attachments: safeTranscriptAttachments(m.attachments),
  }));

  return {
    ticketId: ticket.id,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    priority: ticket.priority,
    owner: {
      id: ticket.owner.id,
      kind: ticket.owner.kind,
      ...(ticket.owner.displayName !== undefined
        ? { displayName: ticket.owner.displayName }
        : {}),
    },
    assignees: ticket.assignees.map((a) => ({
      id: a.id,
      ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
    })),
    summary: buildSummary(ticket, bundle.messages, maxSummaryChars),
    transcript,
    totalMessages: ticket.messageCount,
    visibility: Visibility.PLAYER_SELF,
    source: 'ticket-bot',
    ...(ticket.version !== undefined ? { version: ticket.version } : {}),
    fetchedAt: bundle.fetchedAt,
    traceId,
  };
}
