import type { Ticket } from './types.js';

export interface TicketReportTarget {
  kind: 'minecraft_username';
  value: string;
}

const MINECRAFT_USERNAME = /^[A-Za-z0-9_]{3,16}$/;

/**
 * Extract the bounded player-report subject projected by the Ticket Bot.
 *
 * Older Ticket Bot deployments omit this metadata; callers must treat a
 * missing/invalid target as unavailable rather than guessing from free text.
 */
export function ticketReportTarget(ticket: Ticket): TicketReportTarget | null {
  if (ticket.category !== 'report') return null;
  const metadata = ticket.metadata;
  if (!isRecord(metadata)) return null;
  const target = metadata['reportTarget'];
  if (!isRecord(target)) return null;
  if (target['kind'] !== 'minecraft_username') return null;
  const value = target['value'];
  if (typeof value !== 'string' || !MINECRAFT_USERNAME.test(value)) return null;
  return { kind: 'minecraft_username', value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
