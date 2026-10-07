/**
 * The moderation adapter (W15) — public facade.
 *
 * Responsibilities:
 * 1. Fire-and-forget context enrichment: read moderation decisions for
 *    optional support context. If moderation is down, support continues
 *    normally — enrichment never throws and never blocks.
 * 2. Status query: clients (ops, W21 observability, support UI) can ask
 *    whether the moderation service is reachable, without depending on it.
 * 3. Failure isolation via CircuitBreaker: a downed moderation service
 *    short-circuits locally after a few failures, so support pays no
 *    latency penalty.
 *
 * Boundaries (spec §10.1, §21):
 * - Real-time moderation is NEVER routed through the support LLM. This
 *   module does not classify; it only reads decisions the separate
 *   moderation model already made.
 * - Moderation availability is never a dependency of support. The adapter
 *   degrades to "no context" rather than failing.
 * - No AI Gateway interaction anywhere. The moderation service is a
 *   sibling reached directly over HTTP.
 */

import type { DependencyHealth } from '@enthusia/contracts';
import { ModerationServiceClient, type ModerationClientOptions } from './client.js';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
import type {
  ModerationDecisionContext,
  ModerationServiceStatus,
  SharedIdentityMetadata,
} from './types.js';

export interface ModerationAdapterOptions {
  client: ModerationClientOptions;
  circuitBreaker?: CircuitBreakerOptions;
  /** Logger hook; defaults to a no-op so the adapter never crashes on logging. */
  onLog?: (level: 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void;
}

/** Never-throwing enrichment result. */
export interface EnrichmentResult {
  /** Present only when moderation was reachable and returned decisions. */
  context: ModerationDecisionContext | null;
  /** Whether the moderation service answered (circuit permitting). */
  moderationAvailable: boolean;
}

/** Options a caller can pass per enrichment attempt. */
export interface EnrichmentRequestOptions {
  /** Forwarded to the moderation API's context endpoint. */
  limit?: number;
  /** Abort after this many ms regardless of client timeouts (default 8000). */
  enrichmentTimeoutMs?: number;
}

const DEFAULT_ENRICHMENT_TIMEOUT_MS = 8000;

export class ModerationAdapter {
  private readonly client: ModerationServiceClient;
  private readonly breaker: CircuitBreaker;
  private readonly onLog: NonNullable<ModerationAdapterOptions['onLog']>;
  private readonly adapterVersion = '0.1.0';

  constructor(options: ModerationAdapterOptions) {
    this.client = new ModerationServiceClient(options.client);
    this.breaker = new CircuitBreaker(options.circuitBreaker);
    this.onLog = options.onLog ?? (() => undefined);
  }

  /**
   * Fire-and-forget moderation context enrichment for support.
   *
   * NEVER throws. On any failure — network, timeout, malformed response,
   * open circuit — it resolves with `{ context: null, moderationAvailable:
   * false }` and support proceeds as if there were no moderation history.
   * Callers must not gate support behavior on this result.
   */
  async enrichContext(
    identity: SharedIdentityMetadata,
    options: EnrichmentRequestOptions = {},
  ): Promise<EnrichmentResult> {
    try {
      const timeoutMs = options.enrichmentTimeoutMs ?? DEFAULT_ENRICHMENT_TIMEOUT_MS;
      const decisions = await withTimeout(
        this.breaker.execute(() =>
          this.client.fetchDecisionContext({
            subjectId: identity.moderationSubjectId,
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
          }),
        ),
        timeoutMs,
      );
      return {
        context: {
          subjectId: identity.supportSubjectId,
          decisions,
          fetchedAt: new Date().toISOString(),
          stale: false,
        },
        moderationAvailable: true,
      };
    } catch (err) {
      this.onLog('warn', 'moderation enrichment unavailable; support continues without context', {
        reason: err instanceof Error ? err.message : String(err),
        shortCircuits: this.breaker.stats().totalShortCircuits,
      });
      return { context: null, moderationAvailable: false };
    }
  }

  /**
   * Query moderation status (acceptance: "client can query moderation
   * status"). Observability helper only — support never depends on it.
   * Runs through the circuit breaker; when the breaker is open the answer
   * is 'circuit-open' with no network call.
   */
  async getModerationStatus(): Promise<ModerationServiceStatus> {
    if (this.breaker.currentState === 'open') return 'circuit-open';
    try {
      const health = await this.breaker.execute(() => this.client.queryStatus());
      return health.ready ? 'reachable' : 'degraded';
    } catch (err) {
      this.onLog('warn', 'moderation status query failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return 'unreachable';
    }
  }

  /**
   * DependencyHealth view for §36 readiness/observability consumers (W21).
   * Maps the moderation sibling into the shared contracts shape.
   */
  async moderationDependencyHealth(): Promise<DependencyHealth> {
    const status = await this.getModerationStatus();
    const healthStatus = status === 'reachable' ? 'ok' : status === 'degraded' ? 'degraded' : 'down';
    return {
      name: 'moderation',
      status: healthStatus,
      detail: `moderation service ${status} (breaker ${this.breaker.currentState})`,
    };
  }

  /** Circuit statistics for logs/dashboards. */
  breakerStats() {
    return this.breaker.stats();
  }

  /** Operator/test reset of the breaker. */
  resetBreaker(): void {
    this.breaker.reset();
  }

  get version(): string {
    return this.adapterVersion;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`enrichment timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
