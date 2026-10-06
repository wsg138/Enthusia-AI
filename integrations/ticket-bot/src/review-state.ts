import type { Ticket } from './types.js';

export interface TicketEscalationRecord {
  requestId: string;
  status: 'pending' | 'accepted';
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Return the newest still-relevant staff escalation request projected by the
 * Ticket Bot. Rejected/superseded/expired requests do not suppress a new
 * escalation. Malformed metadata fails closed as "no active escalation".
 */
export function activeTicketEscalation(
  ticket: Ticket,
): TicketEscalationRecord | null {
  const metadata = ticket.metadata;
  if (!isRecord(metadata)) return null;
  const raw = metadata['recentActionRequests'];
  if (!Array.isArray(raw)) return null;

  for (const item of raw) {
    const parsed = escalationRecord(item);
    if (parsed !== null) return parsed;
  }
  return null;
}

function escalationRecord(value: unknown): TicketEscalationRecord | null {
  if (!isRecord(value) || value['action'] !== 'escalate') return null;
  const status = value['status'];
  if (status !== 'pending' && status !== 'accepted') return null;
  const requestId = value['requestId'];
  if (typeof requestId !== 'string' || requestId.trim().length === 0) return null;

  const createdAt = optionalText(value['createdAt']);
  const updatedAt = optionalText(value['updatedAt']);
  return {
    requestId,
    status,
    ...(createdAt !== null ? { createdAt } : {}),
    ...(updatedAt !== null ? { updatedAt } : {}),
  };
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
