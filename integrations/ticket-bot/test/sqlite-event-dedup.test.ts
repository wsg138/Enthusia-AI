import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteTicketEventDeduplicationStore } from '../src/sqlite-event-dedup.js';
import { TicketEventRouter } from '../src/events.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const done of cleanup.splice(0).reverse()) done();
});

function stores(leaseMs = 1_000) {
  const dir = mkdtempSync(join(tmpdir(), 'enthusia-ticket-dedup-'));
  const path = join(dir, 'events.sqlite');
  let now = 1_790_000_000_000;
  const options = { path, leaseMs, clockMs: () => now };
  const one = new SQLiteTicketEventDeduplicationStore(options);
  const two = new SQLiteTicketEventDeduplicationStore(options);
  cleanup.push(() => { one.close(); two.close(); rmSync(dir, { recursive: true, force: true }); });
  return { one, two, options, advance: (ms: number) => { now += ms; } };
}

function event(id: string) {
  return {
    type: 'ticket.message',
    source: 'ticket-bot',
    event_id: id,
    ticket_id: 'private-ticket-id',
    occurred_at: '2026-10-10T00:00:00Z',
    payload: {
      message_id: 'secret-message',
      author: { id: 'hidden', kind: 'player' },
      body: 'private ticket content must never reach dedup database',
    },
  };
}

describe('SQLite durable event claim store', () => {
  it('atomically grants only one of two independently opened SQLite workers', async () => {
    const { one, two } = stores();
    const results = await Promise.all([one.claim('ticket-bot:A'), two.claim('ticket-bot:A')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await two.getState('ticket-bot:A')).toBe('inflight');
    if (results[0]) await one.complete('ticket-bot:A');
    else await two.complete('ticket-bot:A');
    expect(await one.getState('ticket-bot:A')).toBe('completed');
    expect(await two.claim('ticket-bot:A')).toBe(false);
  });

  it('survives closing and reopening processes without replaying acknowledged events', async () => {
    const { one, two, options } = stores();
    expect(await one.claim('ticket-bot:durable')).toBe(true);
    await one.complete('ticket-bot:durable');
    one.close();
    const restarted = new SQLiteTicketEventDeduplicationStore(options);
    try {
      expect(await restarted.claim('ticket-bot:durable')).toBe(false);
      expect(await restarted.getState('ticket-bot:durable')).toBe('completed');
      expect(await two.claim('ticket-bot:distinct')).toBe(true);
    } finally {
      restarted.close();
    }
  });

  it('reclaims expired leases after a crash without ever accepting stale acknowledgements', async () => {
    const { one, two, advance } = stores(50);
    expect(await one.claim('ticket-bot:crash')).toBe(true);
    advance(51);
    expect(await two.getState('ticket-bot:crash')).toBe('expired');
    expect(await two.claim('ticket-bot:crash')).toBe(true);
    await expect(one.complete('ticket-bot:crash')).rejects.toThrow('reassigned');
    await one.release('ticket-bot:crash'); // stale owner cannot delete new lease
    expect(await two.getState('ticket-bot:crash')).toBe('inflight');
    await two.complete('ticket-bot:crash');
    expect(await one.getState('ticket-bot:crash')).toBe('completed');
    expect(await one.claim('ticket-bot:crash')).toBe(false);
  });

  it('releases only its own failed attempt and permits a retry', async () => {
    const { one, two } = stores();
    expect(await one.claim('ticket-bot:retry')).toBe(true);
    await one.release('ticket-bot:retry');
    expect(await two.getState('ticket-bot:retry')).toBe('missing');
    expect(await two.claim('ticket-bot:retry')).toBe(true);
    await two.complete('ticket-bot:retry');
  });

  it('fails closed if the durable store becomes unavailable', async () => {
    const { one } = stores();
    one.close();
    await expect(one.claim('ticket-bot:closed')).rejects.toThrow('closed');
  });

  it('rejects relative database paths and invalid lease limits', () => {
    expect(() => new SQLiteTicketEventDeduplicationStore({ path: './not-persistent.db' }))
      .toThrow('absolute path');
    expect(() => new SQLiteTicketEventDeduplicationStore({ path: ':memory:', leaseMs: 0 }))
      .toThrow('lease duration');
  });

  it('does not acknowledge an in-flight duplicate that might still fail', async () => {
    const { one, two } = stores();
    const first = new TicketEventRouter({ deduplicationStore: one });
    const second = new TicketEventRouter({ deduplicationStore: two });
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    let firstCount = 0;
    let secondCount = 0;
    first.subscribe('ticket.message', async () => { firstCount += 1; await waiting; });
    second.subscribe('ticket.message', () => { secondCount += 1; });
    const a = first.ingest(event('live-A'));
    await Promise.resolve(); // claim() is synchronous before its first await
    await expect(second.ingest(event('live-A'))).rejects.toThrow('retry delivery required');
    expect(secondCount).toBe(0);
    finish();
    await a;
    await expect(second.ingest(event('live-A'))).resolves.toBeDefined();
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(0);
    expect(second.duplicatesSuppressed).toBe(1);
  });

  it('routes failed handlers as retries, not completed tombstones', async () => {
    const { one, two } = stores();
    const first = new TicketEventRouter({ deduplicationStore: one, onHandlerError: () => undefined });
    first.subscribe('ticket.message', () => { throw new Error('transient failure'); });
    await expect(first.ingest(event('transient'))).rejects.toThrow('retry delivery required');
    expect(await two.getState('ticket-bot:transient')).toBe('missing');
    const retry = new TicketEventRouter({ deduplicationStore: two });
    let count = 0;
    retry.subscribe('ticket.message', () => { count += 1; });
    await retry.ingest(event('transient'));
    expect(count).toBe(1);
    expect(await one.getState('ticket-bot:transient')).toBe('completed');
  });
});
