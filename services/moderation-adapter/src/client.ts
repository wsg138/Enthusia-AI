/**
 * HTTP client for the separate AI-Moderation-API service (W15).
 *
 * Moderation is a sibling system. This client never routes through the
 * support LLM or AI Gateway and never makes support availability part of
 * live moderation.
 */

import { ExternalServiceError } from '@enthusia/contracts';
import type {
  DecisionContextRequest,
  FetchFn,
  ModerationContainment,
  ModerationDecision,
  ModerationDecisionSource,
  ModerationHealthWireResponse,
  ModerationMessageAction,
  ModerationPlatform,
  ModerationReviewPriority,
  ModerationSemanticLabel,
  ModerationStrikeRecommendation,
  ModerationSupportFlow,
  SupportContextWireResponse,
} from './types.js';

export interface ModerationClientOptions {
  /** Base URL of AI-Moderation-API, e.g. http://moderation:8080. */
  baseUrl: string;
  /** AI_MOD client ID sent as X-Client-Id on authenticated /v1/* calls. */
  clientId: string;
  /** AI_MOD Bearer credential; runtime-only and never logged. */
  apiKey: string;
  /** HTTP implementation (mock in tests). Defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
  /** Timeout for GET /health/ready. Default 3000 ms. */
  healthTimeoutMs?: number;
  /** Timeout for GET /v1/support-context/{subject}. Default 5000 ms. */
  contextTimeoutMs?: number;
}

const PLATFORMS: readonly ModerationPlatform[] = ['minecraft', 'discord'];
const LABELS: readonly ModerationSemanticLabel[] = [
  'SAFE',
  'GAMEPLAY_VIOLENCE',
  'LOW_LEVEL_HARASSMENT',
  'SEVERE_HARASSMENT',
  'STAFF_TARGETED_ABUSE',
  'REAL_WORLD_THREAT',
  'SELF_HARM_INSTRUCTION',
  'SELF_HARM_INTENT',
  'THIRD_PARTY_SELF_HARM_CONCERN',
  'HATE',
  'SLUR_USE',
  'SEXUAL_CONTENT',
  'SEXUAL_MINOR',
  'DOXXING',
  'BLACKMAIL',
  'GROOMING',
  'DANGEROUS_REAL_WORLD_INSTRUCTIONS',
  'AMBIGUOUS_REVIEW',
];
const ACTIONS: readonly ModerationMessageAction[] = ['ALLOW', 'BLOCK'];
const REVIEW_PRIORITIES: readonly ModerationReviewPriority[] = ['NONE', 'NORMAL', 'URGENT'];
const STRIKE_RECOMMENDATIONS: readonly ModerationStrikeRecommendation[] = [
  'NONE',
  'EVIDENCE',
  'STRIKE',
];
const CONTAINMENTS: readonly ModerationContainment[] = ['NONE', 'MUTE'];
const SUPPORT_FLOWS: readonly ModerationSupportFlow[] = [
  'NONE',
  'SELF_HARM_CHECK',
  'TARGET_SAFETY_CHECK',
];
const DECISION_SOURCES: readonly ModerationDecisionSource[] = ['AI', 'ACCEPTED_CORRECTION'];

type RequestOptions = {
  method: string;
  authenticated: boolean;
  acceptedStatuses?: readonly number[];
};

export class ModerationServiceClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private readonly healthTimeoutMs: number;
  private readonly contextTimeoutMs: number;

  constructor(options: ModerationClientOptions) {
    if (!options.baseUrl || !/^https?:\/\//.test(options.baseUrl)) {
      throw new Error('ModerationServiceClient: baseUrl must be an http(s) URL');
    }
    if (!validCredentialPart(options.clientId)) {
      throw new Error('ModerationServiceClient: clientId is required');
    }
    if (!validCredentialPart(options.apiKey)) {
      throw new Error('ModerationServiceClient: apiKey is required');
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.clientId = options.clientId;
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.healthTimeoutMs = options.healthTimeoutMs ?? 3000;
    this.contextTimeoutMs = options.contextTimeoutMs ?? 5000;
  }

  /**
   * Read moderation readiness directly from the sibling service.
   *
   * AI-Moderation-API intentionally returns HTTP 503 with a structured
   * `not_ready` body when the process is reachable but not ready. That is
   * reported as degraded rather than conflated with a network outage.
   */
  async queryStatus(): Promise<ModerationHealthWireResponse> {
    const raw = await this.requestJson(
      '/health/ready',
      { method: 'GET', authenticated: false, acceptedStatuses: [503] },
      this.healthTimeoutMs,
      '/health/ready',
    );
    return normalizeHealth(raw);
  }

  /**
   * Fetch privacy-minimized effective moderation history for one authoritative
   * canonical identity. This is optional support context, not a live verdict.
   */
  async fetchDecisionContext(request: DecisionContextRequest): Promise<ModerationDecision[]> {
    validateSubjectId(request.subjectId);
    const limit = normalizedLimit(request.limit);
    const path =
      `/v1/support-context/${encodeURIComponent(request.subjectId)}?limit=${limit}`;
    const raw = await this.requestJson(
      path,
      { method: 'GET', authenticated: true },
      this.contextTimeoutMs,
      '/v1/support-context/{subject_id}',
    );
    const response = normalizeContextResponse(raw, request.subjectId);
    return response.decisions
      .map(normalizeDecision)
      .filter((decision): decision is ModerationDecision => decision !== null);
  }

  private headers(authenticated: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authenticated) {
      headers['X-Client-Id'] = this.clientId;
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async requestJson(
    path: string,
    options: RequestOptions,
    timeoutMs: number,
    diagnosticPath: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: this.headers(options.authenticated),
        signal: controller.signal,
      });
      const accepted = options.acceptedStatuses?.includes(response.status) === true;
      if (!response.ok && !accepted) {
        throw new ExternalServiceError(
          'moderation',
          `API responded ${response.status} for ${options.method} ${diagnosticPath}`,
        );
      }
      return await response.json();
    } catch (err) {
      if (err instanceof ExternalServiceError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ExternalServiceError(
          'moderation',
          `API timed out after ${timeoutMs} ms for ${diagnosticPath}`,
        );
      }
      throw new ExternalServiceError(
        'moderation',
        `API unreachable for ${options.method} ${diagnosticPath}: ${errorMessage(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeHealth(raw: unknown): ModerationHealthWireResponse {
  const record = objectRecord(raw);
  if (
    record === null ||
    (record['status'] !== 'ready' && record['status'] !== 'not_ready') ||
    typeof record['ready'] !== 'boolean' ||
    !nullableFiniteNumber(record['schema_version'])
  ) {
    throw new ExternalServiceError('moderation', 'API returned a malformed /health/ready response');
  }
  return {
    status: record['status'],
    ready: record['ready'],
    schema_version: record['schema_version'] as number | null,
  };
}

function normalizeContextResponse(raw: unknown, expectedSubjectId: string): SupportContextWireResponse {
  const record = objectRecord(raw);
  if (
    record === null ||
    record['subject_id'] !== expectedSubjectId ||
    !Array.isArray(record['decisions'])
  ) {
    throw new ExternalServiceError(
      'moderation',
      'API returned a malformed or mismatched support-context response',
    );
  }
  return {
    subject_id: expectedSubjectId,
    decisions: record['decisions'] as SupportContextWireResponse['decisions'],
  };
}

function normalizeDecision(raw: unknown): ModerationDecision | null {
  const record = objectRecord(raw);
  if (record === null) return null;

  const identity = normalizeDecisionIdentity(record);
  const policy = normalizePolicyDimensions(record);
  const reasonCodes = stringArray(record['reason_codes']);
  if (identity === null || policy === null || reasonCodes === null) return null;

  return {
    ...identity,
    ...policy,
    reasonCodes,
  };
}

function normalizeDecisionIdentity(
  record: Record<string, unknown>,
): Pick<
  ModerationDecision,
  'eventId' | 'occurredAt' | 'platform' | 'decisionSource'
> | null {
  const eventId = stringValue(record['event_id']);
  const occurredAt = isoDateValue(record['occurred_at']);
  const platform = enumValue(record['platform'], PLATFORMS);
  const decisionSource = enumValue(record['decision_source'], DECISION_SOURCES);

  if (
    eventId === null ||
    occurredAt === null ||
    platform === null ||
    decisionSource === null
  ) {
    return null;
  }
  return { eventId, occurredAt, platform, decisionSource };
}

function normalizePolicyDimensions(
  record: Record<string, unknown>,
): Pick<
  ModerationDecision,
  | 'semanticLabel'
  | 'messageAction'
  | 'reviewPriority'
  | 'strikeRecommendation'
  | 'containment'
  | 'supportFlow'
> | null {
  const semanticLabel = enumValue(record['semantic_label'], LABELS);
  const messageAction = enumValue(record['message_action'], ACTIONS);
  const reviewPriority = enumValue(record['review_priority'], REVIEW_PRIORITIES);
  const strikeRecommendation = enumValue(
    record['strike_recommendation'],
    STRIKE_RECOMMENDATIONS,
  );
  const containment = enumValue(record['containment'], CONTAINMENTS);
  const supportFlow = enumValue(record['support_flow'], SUPPORT_FLOWS);

  if (
    semanticLabel === null ||
    messageAction === null ||
    reviewPriority === null ||
    strikeRecommendation === null ||
    containment === null ||
    supportFlow === null
  ) {
    return null;
  }
  return {
    semanticLabel,
    messageAction,
    reviewPriority,
    strikeRecommendation,
    containment,
    supportFlow,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isoDateValue(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | null {
  if (typeof value !== 'string') return null;
  return values.includes(value as T) ? (value as T) : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value.slice(0, 32) as string[];
}

function validCredentialPart(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validateSubjectId(value: string): void {
  if (
    value.length < 1 ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ExternalServiceError('moderation', 'invalid moderation subject identity');
  }
}

function normalizedLimit(value: number | undefined): number {
  if (value === undefined) return 10;
  if (!Number.isFinite(value)) return 10;
  return Math.min(25, Math.max(1, Math.floor(value)));
}

function nullableFiniteNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
