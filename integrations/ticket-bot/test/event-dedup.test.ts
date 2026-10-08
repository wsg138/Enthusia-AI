import { describe, expect, it } from 'vitest';

import {
  InMemoryTicketEventDeduplicationStore,
  type TicketEventDeduplicationStore,
} from '../src/event-dedup.js';
import { TicketEventRouter } from '../src/events.js';

function closedEvent(eventId: string) {
  return {
    type: 'ticket.closed',
    event_id: eventId,
    ticket_id: 'T-1234',
    occurred_at: '2026-10-08T14:00:00.000Z',
    source: 'ticket-bot',
    payload: { close_reason: 'resolved' },
  };
}

describe('TicketEventRouter delivery deduplication', () => {
  it('suppresses a repeated event_id before handlers run twice', async () => {
    const duplicates: string[] = [];
    const router = new TicketEventRouter({
      onDuplicate: (event) => duplicates.push(event.eventId),
    });
    const seen: string[] = [];
    router.subscribe('ticket.closed', (event) => {
      seen.push(event.eventId);
    });

    await router.ingest(closedEvent('event-1'));
    await router.ingest(closedEvent('event-1'));

    expect(seen).toEqual(['event-1']);
    expect(duplicates).toEqual(['event-1']);
    expect(router.duplicatesSuppressed).toBe(1);
  });

  it('atomically suppresses concurrent duplicate deliveries', async () => {
    const router = new TicketEventRouter();
    const seen: string[] = [];
    router.subscribe('ticket.closed', async (event) => {
      await Promise.resolve();
      seen.push(event.eventId);
    });

    await Promise.all([
      router.ingest(closedEvent('event-concurrent')),
      router.ingest(closedEvent('event-concurrent')),
    ]);

    expect(seen).toEqual(['event-concurrent']);
    expect(router.duplicatesSuppressed).toBe(1);
  });

  it('dispatches distinct event ids independently', async () => {
    const router = new TicketEventRouter();
    const seen: string[] = [];
    router.subscribe('*', (event) => {
      seen.push(event.eventId);
    });

    await router.ingest(closedEvent('event-a'));
    await router.ingest(closedEvent('event-b'));

    expect(seen).toEqual(['event-a', 'event-b']);
    expect(router.duplicatesSuppressed).toBe(0);
  });

  it('releases a failed delivery so it can be retried', async () => {
    const errors: string[] = [];
    const router = new TicketEventRouter({
      onHandlerError: (error) => errors.push(String(error)),
    });
    let attempts = 0;
    router.subscribe('ticket.closed', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient write failure');
    });
    await expect(router.ingest(closedEvent('retry-1'))).rejects.toThrow(
      'retry delivery required',
    );
    await expect(router.ingest(closedEvent('retry-1'))).resolves.toBeDefined();
    await router.ingest(closedEvent('retry-1'));
    expect(attempts).toBe(2);
    expect(router.duplicatesSuppressed).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('refuses to evict active claims under bounded capacity', async () => {
    const store = new InMemoryTicketEventDeduplicationStore(1);
    expect(await store.claim('ticket-bot:a')).toBe(true);
    await expect(store.claim('ticket-bot:b')).rejects.toThrow(
      'too many concurrent ticket event claims',
    );
    expect(store.size).toBe(1);
    await store.release('ticket-bot:a');
    expect(await store.claim('ticket-bot:b')).toBe(true);
    await store.complete('ticket-bot:b');
  });

  it('fails closed when the injected deduplication store cannot claim', async () => {
    const store: TicketEventDeduplicationStore = {
      claim: async () => {
        throw new Error('dedup store unavailable');
      },
      complete: async () => undefined,
      release: async () => undefined,
    };
    const router = new TicketEventRouter({ deduplicationStore: store });
    let calls = 0;
    router.subscribe('*', () => {
      calls += 1;
    });

    await expect(router.ingest(closedEvent('event-fail'))).rejects.toThrow(
      'dedup store unavailable',
    );
    expect(calls).toBe(0);
  });

  it('bounds process-local memory and documents eviction behavior', async () => {
    const store = new InMemoryTicketEventDeduplicationStore(2);

    expect(await store.claim('ticket-bot:a')).toBe(true);
    await store.complete('ticket-bot:a');
    expect(await store.claim('ticket-bot:b')).toBe(true);
    await store.complete('ticket-bot:b');
    expect(await store.claim('ticket-bot:c')).toBe(true);
    await store.complete('ticket-bot:c');
    expect(store.size).toBe(2);

    expect(await store.claim('ticket-bot:a')).toBe(true);
  });
});
