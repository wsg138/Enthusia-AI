/**
 * HTTP client for the separate moderation service (W15).
 *
 * This client talks *directly* to the moderation API. It never routes
 * through the AI Gateway or the support LLM (§10.1, §21.1: moderation is a
 * sibling system with independent health). No AI Gateway availability is
 * required or consulted anywhere in this module.
 *
 * - The fetch implementation is injected (`fetchFn`); tests pass a mock.
 *   There is NO real moderation service connection anywhere in this repo.
 * - Every request carries a timeout via AbortController; slow moderation
 *   must never stall support.
 * - Auth, when configured, is a Bearer token sent only to the configured
 *   baseUrl. Error messages never include secrets (§5.5).
 */

import { ExternalServiceError } from '@enthusia/contracts';
import type {
  DecisionContextRequest,
  DecisionContextWireResponse,
  FetchFn,
  ModerationHealthWireResponse,
  ModerationDecision,
  ModerationVerdict,
} from './types.js';

export interface ModerationClientOptions {
  /** Base URL of the moderation API, e.g. http://moderation:8080. */
  baseUrl: string;
  /** Bearer token for the moderation API (optional; never logged). */
  apiKey?: string;
  /** HTTP implementation (mock in tests). Defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
  /** Timeout for GET /health. Default 3000 ms. */
  healthTimeoutMs?: number;
  /** Timeout for POST /v1/decisions/context. Default 5000 ms. */
  contextTimeoutMs?: number;
}

const VALID_VERDICTS: readonly ModerationVerdict[] = ['clean', 'flagged', 'blocked'];

function normalizeDecision(raw: unknown, fallbackSubjectId: string): ModerationDecision | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const verdict = d['verdict'];
  if (typeof verdict !== 'string' || !VALID_VERDICTS.includes(verdict as ModerationVerdict)) {
    return null;
  }
  if (typeof d['id'] !== 'string' || typeof d['summary'] !== 'string') return null;
  if (typeof d['decidedAt'] !== 'string' || Number.isNaN(Date.parse(d['decidedAt']))) return null;
  const categories = Array.isArray(d['categories'])
    ? d['categories'].filter((c): c is string => typeof c === 'string')
    : [];
  const decision: ModerationDecision = {
    id: d['id'],
    subjectId: typeof d['subjectId'] === 'string' ? d['subjectId'] : fallbackSubjectId,
    verdict: verdict as ModerationVerdict,
    categories,
    summary: d['summary'],
    decidedAt: d['decidedAt'],
  };
  if (typeof d['appealed'] === 'boolean') decision.appealed = d['appealed'];
  return decision;
}

export class ModerationServiceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: FetchFn;
  private readonly healthTimeoutMs: number;
  private readonly contextTimeoutMs: number;

  constructor(options: ModerationClientOptions) {
    if (!options.baseUrl || !/^https?:\/\//.test(options.baseUrl)) {
      throw new Error('ModerationServiceClient: baseUrl must be an http(s) URL');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.healthTimeoutMs = options.healthTimeoutMs ?? 3000;
    this.contextTimeoutMs = options.contextTimeoutMs ?? 5000;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey !== undefined) headers['Authorization'] = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async request<T>(path: string, init: { method: string; body?: string }, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const requestInit: RequestInit = {
      method: init.method,
      headers: this.headers(),
      signal: controller.signal,
    };
    if (init.body !== undefined) requestInit.body = init.body;
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, requestInit);
      if (!response.ok) {
        throw new ExternalServiceError(
          'moderation',
          `API responded ${response.status} for ${init.method} ${path}`,
        );
      }
      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof ExternalServiceError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ExternalServiceError('moderation', `API timed out after ${timeoutMs} ms for ${path}`);
      }
      throw new ExternalServiceError(
        'moderation',
        `API unreachable for ${init.method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Query moderation status (acceptance criterion: "client can query
   * moderation status"). Returns the service's self-reported health;
   * network/timeout failures throw ExternalServiceError so the breaker
   * and the adapter can count them.
   */
  async queryStatus(): Promise<ModerationHealthWireResponse> {
    const raw = await this.request<ModerationHealthWireResponse>(
      '/health',
      { method: 'GET' },
      this.healthTimeoutMs,
    );
    if (
      typeof raw !== 'object' ||
      raw === null ||
      (raw.status !== 'ok' && raw.status !== 'degraded' && raw.status !== 'down')
    ) {
      throw new ExternalServiceError('moderation', 'API returned a malformed /health response');
    }
    return raw;
  }

  /**
   * Fetch recent moderation decisions for an identity — optional support
   * context only. Malformed decisions are dropped individually (never the
   * whole response). Failures throw ExternalServiceError.
   */
  async fetchDecisionContext(request: DecisionContextRequest): Promise<ModerationDecision[]> {
    const raw = await this.request<DecisionContextWireResponse>(
      '/v1/decisions/context',
      { method: 'POST', body: JSON.stringify({ subjectId: request.subjectId, limit: request.limit ?? 10 }) },
      this.contextTimeoutMs,
    );
    if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.decisions)) {
      throw new ExternalServiceError('moderation', 'API returned a malformed decisions/context response');
    }
    return raw.decisions
      .map((d) => normalizeDecision(d, request.subjectId))
      .filter((d): d is ModerationDecision => d !== null);
  }
}
