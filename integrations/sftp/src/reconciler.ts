/**
 * @enthusia/integration-sftp — periodic reconciliation scheduler (W09).
 *
 * Even when change-driven triggers exist elsewhere, spec §12.3 requires
 * periodic reconciliation: recover missed events, detect manual config
 * edits, detect out-of-band deployments, verify mirrors. This scheduler
 * runs one `SftpIndexer.scan()` per configured server on a timer.
 *
 * Properties:
 * - Single-flight: a tick that arrives while a run is in progress is
 *   skipped (counted), never run concurrently.
 * - Jitter: each interval gets a random 0..jitterMs delay so multiple
 *   servers/hosts do not stampede the SFTP server on the same second.
 * - Fail-soft: a failed run is recorded (lastError, consecutiveFailures)
 *   and the schedule continues; the error is also surfaced to the caller
 *   via onError.
 * - State introspection for the §36 health surface: lastRunAt,
 *   lastSuccessAt, lastError, nextRunAt, consecutiveFailures, runsTotal.
 *
 * The scheduler does NOT own connections: it asks a `ClientFactory` for a
 * fresh guarded client per run so a broken connection cannot wedge future
 * runs. `SftpClientFactory` is `(serverId) => Promise<SftpClient>`.
 */

import { SftpIndexer, type ScanResult, type SftpIndexerDeps } from './indexer.js';
import type { CompiledSftpIndexerConfig, SftpServerConfig } from './config.js';
import type { SftpClient } from './sftp-client.js';

export type SftpClientFactory = (serverId: string) => Promise<SftpClient>;

export interface ReconcileRunSummary {
  serverId: string;
  result: ScanResult;
}

export interface ReconcilerCallbacks {
  /** Called after each server scan completes (success or per-file errors). */
  onRun?: (summary: ReconcileRunSummary) => void;
  /** Called when a whole run fails (connect error, unexpected throw). */
  onError?: (serverId: string, error: Error) => void;
}

export interface ReconcilerState {
  running: boolean;
  runsTotal: number;
  runsSkippedOverlapping: number;
  consecutiveFailures: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  nextRunAt?: string;
}

export interface ReconcilerOptions {
  intervalMs: number;
  jitterMs?: number;
  random?: () => number;
  now?: () => number;
  callbacks?: ReconcilerCallbacks;
}

const DEFAULT_JITTER_MS = 60_000;

export class SftpReconciler {
  private readonly compiled: CompiledSftpIndexerConfig;
  private readonly makeClient: SftpClientFactory;
  private readonly makeDeps: (client: SftpClient) => Omit<SftpIndexerDeps, 'client'>;
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly callbacks: ReconcilerCallbacks;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private readonly state: ReconcilerState = {
    running: false,
    runsTotal: 0,
    runsSkippedOverlapping: 0,
    consecutiveFailures: 0,
  };

  constructor(
    compiled: CompiledSftpIndexerConfig,
    makeClient: SftpClientFactory,
    makeDeps: (client: SftpClient) => Omit<SftpIndexerDeps, 'client'>,
    options: ReconcilerOptions,
  ) {
    if (options.intervalMs <= 0) {
      throw new Error('reconcile interval must be positive');
    }
    this.compiled = compiled;
    this.makeClient = makeClient;
    this.makeDeps = makeDeps;
    this.intervalMs = options.intervalMs;
    this.jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.callbacks = options.callbacks ?? {};
  }

  /** Snapshot of scheduler health (safe for the §36 health endpoint). */
  getState(): ReconcilerState {
    return { ...this.state };
  }

  start(): void {
    if (this.state.running) return;
    this.state.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.state.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    delete this.state.nextRunAt;
  }

  /** Run one full reconciliation pass immediately (still single-flight). */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  private scheduleNext(): void {
    if (!this.state.running) return;
    const delay = this.intervalMs + Math.floor(this.random() * (this.jitterMs + 1));
    this.state.nextRunAt = new Date(this.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, delay);
    // Don't hold the process open for the scheduler alone.
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      this.state.runsSkippedOverlapping += 1;
      return;
    }
    this.inFlight = true;
    try {
      for (const server of this.compiled.config.servers) {
        await this.scanServer(server);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async scanServer(server: SftpServerConfig): Promise<void> {
    const isoNow = (): string => new Date(this.now()).toISOString();
    this.state.lastRunAt = isoNow();
    let client: SftpClient | undefined;
    try {
      client = await this.makeClient(server.id);
      const deps: SftpIndexerDeps = { client, ...this.makeDeps(client) };
      const indexer: SftpIndexer = new SftpIndexer(server.id, server.roots, deps, {
        maxFileBytes: this.compiled.config.maxFileBytes,
        maxDepth: this.compiled.config.maxDepth,
        extraDenyByRoot: this.compiled.extraDenyByRoot,
        now: isoNow,
      });
      const result = await indexer.scan();
      this.state.runsTotal += 1;
      this.state.consecutiveFailures = 0;
      this.state.lastSuccessAt = isoNow();
      delete this.state.lastError;
      this.callbacks.onRun?.({ serverId: server.id, result });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.state.runsTotal += 1;
      this.state.consecutiveFailures += 1;
      this.state.lastError = error.message;
      this.callbacks.onError?.(server.id, error);
    } finally {
      try {
        await client?.close();
      } catch {
        // Close failures must not fail the run or the schedule.
      }
    }
  }
}
