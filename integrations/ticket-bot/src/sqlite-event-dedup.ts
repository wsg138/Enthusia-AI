import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { ValidationError } from '@enthusia/contracts';
import type { TicketEventClaimState, TicketEventDeduplicationStore } from './event-dedup.js';

/** SQLite is persistent only when stored on an approved, durable volume. */
export interface SQLiteTicketEventDeduplicationOptions {
  path: string;
  leaseMs?: number;
  clockMs?: () => number;
}

interface Row {
  state: 'inflight' | 'completed';
  lease_until_ms: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticket_event_claims (
  key_hash TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('inflight','completed')),
  owner_token TEXT,
  lease_until_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  CHECK ((state = 'completed' AND completed_at_ms IS NOT NULL AND owner_token IS NULL)
      OR (state = 'inflight' AND completed_at_ms IS NULL AND owner_token IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_ticket_event_claims_lease
  ON ticket_event_claims(state, lease_until_ms);
`;

/**
 * Atomic lease and durable completion store. Stores hashes of event keys only;
 * it does not persist ticket identifiers, messages or staff-private content.
 * At-least-once downstream subscribers MUST implement their own idempotency:
 * a handler may finish but the process may crash before complete() commits.
 */
export class SQLiteTicketEventDeduplicationStore implements TicketEventDeduplicationStore {
  private readonly db: Database.Database;
  private readonly leaseMs: number;
  private readonly clockMs: () => number;
  private readonly owned = new Map<string, string>();
  private closed = false;

  constructor(options: SQLiteTicketEventDeduplicationOptions) {
    if (!options || typeof options.path !== 'string' ||
        (options.path !== ':memory:' && !isAbsolute(options.path))) {
      throw new ValidationError('Durable ticket claim database needs an absolute path.');
    }
    this.leaseMs = options.leaseMs ?? 600_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1 ||
        this.leaseMs > 86_400_000) {
      throw new ValidationError('Invalid ticket event lease duration.');
    }
    this.clockMs = options.clockMs ?? Date.now;
    this.db = new Database(options.path, { timeout: 5_000 });
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('busy_timeout = 5000');
      this.db.exec(SCHEMA);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private now(): number {
    const value = this.clockMs();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError('Invalid ticket event deduplication clock.');
    }
    return value;
  }

  private digest(key: string): string {
    if (typeof key !== 'string' || key.length < 1 || key.length > 512) {
      throw new ValidationError('Invalid ticket event deduplication key.');
    }
    return createHash('sha256').update(key, 'utf8').digest('hex');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Ticket deduplication database is closed.');
  }

  async claim(key: string): Promise<boolean> {
    this.assertOpen();
    const digest = this.digest(key);
    if (this.owned.has(digest)) return false;
    const now = this.now();
    const until = now + this.leaseMs;
    if (!Number.isSafeInteger(until)) throw new ValidationError('Invalid lease deadline.');
    const token = randomUUID();
    const acquire = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT state, lease_until_ms FROM ticket_event_claims WHERE key_hash = ?',
      ).get(digest) as Row | undefined;
      if (row?.state === 'completed') return false;
      if (row?.state === 'inflight' && row.lease_until_ms > now) return false;
      if (!row) {
        this.db.prepare(`
          INSERT INTO ticket_event_claims
          (key_hash, state, owner_token, lease_until_ms, completed_at_ms)
          VALUES (?, 'inflight', ?, ?, NULL)
        `).run(digest, token, until);
      } else {
        const change = this.db.prepare(`
          UPDATE ticket_event_claims SET owner_token = ?, lease_until_ms = ?
          WHERE key_hash = ? AND state = 'inflight' AND lease_until_ms <= ?
        `).run(token, until, digest, now);
        if (change.changes !== 1) return false;
      }
      return true;
    });
    const accepted = acquire.immediate();
    if (accepted) this.owned.set(digest, token);
    return accepted;
  }

  /** Production ingress must retry still-in-flight deliveries, not acknowledge them. */
  async getState(key: string): Promise<TicketEventClaimState> {
    this.assertOpen();
    const row = this.db.prepare(
      'SELECT state, lease_until_ms FROM ticket_event_claims WHERE key_hash = ?',
    ).get(this.digest(key)) as Row | undefined;
    if (!row) return 'missing';
    if (row.state === 'completed') return 'completed';
    return row.lease_until_ms > this.now() ? 'inflight' : 'expired';
  }

  async complete(key: string): Promise<void> {
    this.assertOpen();
    const digest = this.digest(key);
    const token = this.owned.get(digest);
    if (!token) throw new ValidationError('Ticket claim not owned by this worker.');
    const change = this.db.prepare(`
      UPDATE ticket_event_claims
      SET state = 'completed', owner_token = NULL, completed_at_ms = ?, lease_until_ms = 0
      WHERE key_hash = ? AND state = 'inflight' AND owner_token = ?
    `).run(this.now(), digest, token);
    this.owned.delete(digest);
    if (change.changes !== 1) {
      throw new ValidationError('Ticket claim was reassigned; acknowledgement refused.');
    }
  }

  async release(key: string): Promise<void> {
    this.assertOpen();
    const digest = this.digest(key);
    const token = this.owned.get(digest);
    if (!token) return;
    this.db.prepare(`
      DELETE FROM ticket_event_claims
      WHERE key_hash = ? AND state = 'inflight' AND owner_token = ?
    `).run(digest, token);
    this.owned.delete(digest);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.owned.clear();
    this.db.close();
  }
}
