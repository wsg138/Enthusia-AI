import { z } from 'zod';
import {
  AuthorizationError,
  ExternalServiceError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '@enthusia/contracts';
import type {
  StaffModerationClientConfig,
  StaffModerationStateSnapshot,
} from './types.js';

export const STAFF_MODERATION_SERVICE = 'enthusia-staff';
export const STAFF_MODERATION_STATE_PATH = '/v1/ai/moderation-state';

const minecraftUsername = /^[A-Za-z0-9_]{3,16}$/;

const targetSchema = z.strictObject({
  requested: z.string().regex(minecraftUsername),
  playerId: z.string().uuid(),
  username: z.string().regex(minecraftUsername).nullable().optional(),
});

const activeSanctionSchema = z.strictObject({
  sanctionId: z.string().uuid(),
  caseId: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  publicReason: z.string().min(1).max(160),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable().optional(),
});

const caseSchema = z.strictObject({
  caseId: z.string().min(1).max(128),
  exactReasonId: z.string().min(1).max(96),
  sanctionFamily: z.string().min(1).max(64),
  state: z.string().min(1).max(32),
  publicReason: z.string().min(1).max(160),
  issuedAt: z.iso.datetime(),
  hasActiveSanctions: z.boolean(),
  configurationVersion: z.string().min(1).max(128),
});

const stateSchema = z.strictObject({
  service: z.literal('enthusia-staff'),
  api: z.literal('ai-moderation-state'),
  contractVersion: z.literal('v1'),
  target: targetSchema,
  activeSanctions: z.array(activeSanctionSchema).max(32),
  recentCases: z.array(caseSchema).max(16),
  fetchedAt: z.iso.datetime(),
});

export function assertAllowedStaffModerationRequest(
  method: string,
  path: string,
): void {
  if (method === 'POST' && path === STAFF_MODERATION_STATE_PATH) return;
  throw new ValidationError(
    `Staff moderation client refuses ${method} ${path}: only the bounded read endpoint is allowed.`,
  );
}

export class StaffModerationStateClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(config: StaffModerationClientConfig) {
    this.baseUrl = requiredBaseUrl(config.baseUrl);
    this.apiKey = requiredApiKey(config.apiKey);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchImpl =
      config.fetchImpl ??
      (globalThis.fetch.bind(globalThis) as typeof fetch);
    this.userAgent =
      config.userAgent ?? 'enthusia-ai/staff-moderation-read (+v1)';
  }

  async getState(target: string): Promise<StaffModerationStateSnapshot> {
    requireMinecraftUsername(target);
    const response = await this.request(target);
    if (!response.ok) throw await responseError(response);
    const raw = await response.json();
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ExternalServiceError(
        STAFF_MODERATION_SERVICE,
        'EnthusiaStaff returned an incompatible moderation-state contract.',
      );
    }
    if (parsed.data.target.requested.toLowerCase() !== target.toLowerCase()) {
      throw new ExternalServiceError(
        STAFF_MODERATION_SERVICE,
        'EnthusiaStaff moderation-state target did not match the request.',
      );
    }
    return parsed.data;
  }

  private async request(target: string): Promise<Response> {
    assertAllowedStaffModerationRequest('POST', STAFF_MODERATION_STATE_PATH);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(
        this.baseUrl + STAFF_MODERATION_STATE_PATH,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': this.userAgent,
          },
          body: '{"target":' + JSON.stringify(target) + '}',
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw transportError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function requiredBaseUrl(value: string): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed.replace(/\/+$/, '');
  throw new ValidationError('StaffModerationStateClient requires a baseUrl.');
}

function requiredApiKey(value: string): string {
  if (value?.trim()) return value.trim();
  throw new ValidationError('StaffModerationStateClient requires an apiKey.');
}

function requireMinecraftUsername(value: string): void {
  if (minecraftUsername.test(value)) return;
  throw new ValidationError(
    'Staff moderation state target must be a Minecraft username.',
  );
}

function transportError(error: unknown): ExternalServiceError {
  const message =
    error instanceof Error && error.name === 'AbortError'
      ? 'EnthusiaStaff moderation-state request timed out.'
      : 'EnthusiaStaff moderation-state request failed.';
  return new ExternalServiceError(STAFF_MODERATION_SERVICE, message);
}

async function responseError(response: Response): Promise<Error> {
  const detail = await safeErrorBody(response);
  switch (response.status) {
    case 401:
    case 403:
      return new AuthorizationError(
        `EnthusiaStaff denied moderation-state read: ${detail}`,
      );
    case 404:
      return new NotFoundError('Moderation target was not found.');
    case 409:
      return new ValidationError('Moderation target is ambiguous.');
    case 429:
      return new RateLimitError(
        'EnthusiaStaff moderation-state rate limit exceeded.',
      );
    default:
      return new ExternalServiceError(
        STAFF_MODERATION_SERVICE,
        `Moderation-state read failed with status ${response.status}: ${detail}`,
      );
  }
}

async function safeErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 240) || response.statusText;
  } catch {
    return response.statusText;
  }
}
