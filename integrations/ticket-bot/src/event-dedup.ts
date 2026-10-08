import { ValidationError } from '@enthusia/contracts';

export interface TicketEventDeduplicationStore {
  /**
   * Atomically claim an event key.
   *
   * Returns true only for the first successful claim. Durable production
   * implementations should enforce uniqueness across processes/restarts.
   */
  claim(key: string): Promise<boolean>;
}

export interface TicketEventIdentity {
  source: string;
  eventId: string;
}

export function ticketEventDeduplicationKey(event: TicketEventIdentity): string {
  return `${event.source}:${event.eventId}`;
}

/**
 * Bounded process-local deduplication for tests, development, and shadow mode.
 *
 * This reduces duplicate effects within one process, but it is deliberately
 * not described as durable. Production webhook ingress should inject a store
 * backed by persistence with an atomic unique claim.
 */
export class InMemoryTicketEventDeduplicationStore
  implements TicketEventDeduplicationStore
{
  private readonly claimed = new Map<string, true>();

  constructor(private readonly maxEntries = 10_000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new ValidationError('Ticket event deduplication maxEntries must be a positive integer.');
    }
  }

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) return false;
    this.claimed.set(key, true);
    this.evictOldestIfNeeded();
    return true;
  }

  get size(): number {
    return this.claimed.size;
  }

  private evictOldestIfNeeded(): void {
    if (this.claimed.size <= this.maxEntries) return;
    const oldest = this.claimed.keys().next().value as string | undefined;
    if (oldest !== undefined) this.claimed.delete(oldest);
  }
}
