import { ValidationError } from '@enthusia/contracts';

export type TicketEventClaimState = 'missing' | 'inflight' | 'expired' | 'completed';

export interface TicketEventDeduplicationStore {
  /**
   * Atomically claim an event key.
   *
   * Returns true only when this worker acquires the right to attempt delivery.
   * A durable implementation must use an expiring lease for in-flight claims,
   * retain completed keys, and atomically prevent parallel claim ownership.
   * Delivery may happen more than once after crashes: handlers must be idempotent.
   */
  claim(key: string): Promise<boolean>;
  /** Optional strict duplicate inspection for production durable stores. */
  getState?(key: string): Promise<TicketEventClaimState>;
  /** Mark the delivery completed only after every subscriber succeeded. */
  complete(key: string): Promise<void>;
  /** Allow a future retry if any subscriber failed. */
  release(key: string): Promise<void>;
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
  private readonly claimed = new Map<string, 'inflight' | 'completed'>();

  constructor(private readonly maxEntries = 10_000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new ValidationError('Ticket event deduplication maxEntries must be a positive integer.');
    }
  }

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) return false;
    this.makeRoomBeforeClaim();
    this.claimed.set(key, 'inflight');
    return true;
  }

  async complete(key: string): Promise<void> {
    if (this.claimed.get(key) !== 'inflight') {
      throw new ValidationError('cannot complete an unclaimed ticket event');
    }
    this.claimed.set(key, 'completed');
  }

  async release(key: string): Promise<void> {
    if (this.claimed.get(key) === 'inflight') this.claimed.delete(key);
  }

  get size(): number {
    return this.claimed.size;
  }

  private makeRoomBeforeClaim(): void {
    if (this.claimed.size < this.maxEntries) return;
    // Never evict an in-flight claim; doing so could dispatch concurrently.
    // A bounded test store may reject further deliveries until a handler ends.
    for (const [key, state] of this.claimed) {
      if (state === 'completed') {
        this.claimed.delete(key);
        return;
      }
    }
    throw new ValidationError('too many concurrent ticket event claims');
  }
}
