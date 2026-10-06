import { z } from 'zod';
import { ticketReportTarget } from '@enthusia/integration-ticket-bot';
import type {
  TicketEvidencePipelineInput,
  TicketEvidencePipelineResult,
} from './pipeline.js';
import { runTicketEvidencePipeline } from './pipeline.js';
import type { AuthoritativeModerationState } from './types.js';

const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 10_000;
const usernameSchema = z.string().regex(/^[A-Za-z0-9_]{3,16}$/);
const isoTimeSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  'timestamp must be ISO-compatible',
);

const activeSanctionSchema = z.strictObject({
  sanctionId: z.string().min(1).max(128),
  caseId: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  reason: z.string().min(1).max(512),
  exactReasonId: z.string().min(1).max(96).nullable(),
  sanctionFamily: z.string().min(1).max(96).nullable(),
  issuedAt: isoTimeSchema,
  expiresAt: isoTimeSchema.nullable(),
});

const recentCaseSchema = z.strictObject({
  caseId: z.string().min(1).max(128),
  exactReasonId: z.string().min(1).max(96),
  sanctionFamily: z.string().min(1).max(96),
  state: z.enum(['OPEN', 'CLOSED', 'FULLY_OVERTURNED']),
  issuedAt: isoTimeSchema,
});

const subjectStateSchema = z.strictObject({
  resolution: z.enum(['RESOLVED', 'MISSING', 'AMBIGUOUS']),
  requestedUsername: usernameSchema,
  playerId: z.string().uuid().nullable(),
  activeSanctions: z.array(activeSanctionSchema).max(16),
  recentCases: z.array(recentCaseSchema).max(16),
  observedAt: isoTimeSchema,
});

export type StaffModerationSubjectState = z.infer<typeof subjectStateSchema>;

export interface StaffModerationStateClientOptions {
  baseUrl: string;
  bearerToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class StaffModerationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffModerationStateError';
  }
}

export class StaffModerationStateClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StaffModerationStateClientOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.bearerToken = requireBearer(options.bearerToken);
    this.timeoutMs = boundedTimeout(options.timeoutMs);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getSubjectState(username: string): Promise<StaffModerationSubjectState> {
    const target = usernameSchema.parse(username);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        this.baseUrl + '/v1/ai/moderation/subject-state',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + this.bearerToken,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ minecraftUsername: target }),
          signal: controller.signal,
        },
      );
    } catch {
      throw new StaffModerationStateError(
        'Authoritative moderation-state service is unavailable.',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new StaffModerationStateError(
        'Authoritative moderation-state request failed.',
      );
    }
    requireBoundedContentLength(response);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new StaffModerationStateError(
        'Authoritative moderation-state response exceeded the size bound.',
      );
    }
    return parseSubjectState(text, target);
  }
}

export function authoritativeStateFromStaff(
  state: StaffModerationSubjectState,
): AuthoritativeModerationState {
  if (state.resolution !== 'RESOLVED') {
    return {
      availability: 'unavailable',
      target: state.requestedUsername,
      duplicateStatus: 'none',
      activeSanctions: [],
      fetchedAt: state.observedAt,
    };
  }

  return {
    availability: 'verified',
    target: state.requestedUsername,
    duplicateStatus: 'none',
    activeSanctions: state.activeSanctions.map((sanction) => ({
      id: sanction.sanctionId,
      type: sanction.type,
      status: 'ACTIVE',
      reason: sanction.reason,
      caseId: sanction.caseId,
      ...(sanction.exactReasonId !== null
        ? { exactReasonId: sanction.exactReasonId }
        : {}),
      ...(sanction.sanctionFamily !== null
        ? { sanctionFamily: sanction.sanctionFamily }
        : {}),
      issuedAt: sanction.issuedAt,
      ...(sanction.expiresAt !== null
        ? { expiresAt: sanction.expiresAt }
        : {}),
    })),
    fetchedAt: state.observedAt,
  };
}

export interface TicketEvidencePipelineWithStaffStateInput
  extends Omit<TicketEvidencePipelineInput, 'moderationState'> {
  moderationReader: Pick<StaffModerationStateClient, 'getSubjectState'>;
}

export interface TicketEvidencePipelineWithStaffStateResult {
  moderationSnapshot: StaffModerationSubjectState | null;
  pipeline: TicketEvidencePipelineResult;
}

export async function runTicketEvidencePipelineWithStaffState(
  input: TicketEvidencePipelineWithStaffStateInput,
): Promise<TicketEvidencePipelineWithStaffStateResult> {
  const target = ticketReportTarget(input.ticket.ticket);
  let snapshot: StaffModerationSubjectState | null = null;
  let moderationState = unavailableState(target?.value ?? '');

  if (target !== null) {
    try {
      snapshot = await input.moderationReader.getSubjectState(target.value);
      moderationState = authoritativeStateFromStaff(snapshot);
    } catch {
      moderationState = unavailableState(target.value);
    }
  }

  const pipeline = await runTicketEvidencePipeline({
    ...input,
    moderationState,
  });
  return { moderationSnapshot: snapshot, pipeline };
}

function unavailableState(target: string): AuthoritativeModerationState {
  return {
    availability: 'unavailable',
    target,
    duplicateStatus: 'none',
    activeSanctions: [],
  };
}

function parseSubjectState(
  text: string,
  expectedTarget: string,
): StaffModerationSubjectState {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new StaffModerationStateError(
      'Authoritative moderation-state response was not valid JSON.',
    );
  }
  const parsed = subjectStateSchema.safeParse(json);
  if (!parsed.success) {
    throw new StaffModerationStateError(
      'Authoritative moderation-state response had an invalid shape.',
    );
  }
  if (
    parsed.data.requestedUsername.toLowerCase() !==
    expectedTarget.toLowerCase()
  ) {
    throw new StaffModerationStateError(
      'Authoritative moderation-state target did not match the request.',
    );
  }
  validateResolutionShape(parsed.data);
  return parsed.data;
}

function validateResolutionShape(state: StaffModerationSubjectState): void {
  if (state.resolution === 'RESOLVED') {
    if (state.playerId !== null) return;
    throw new StaffModerationStateError(
      'Resolved moderation state did not include a player identity.',
    );
  }
  if (
    state.playerId === null &&
    state.activeSanctions.length === 0 &&
    state.recentCases.length === 0
  ) {
    return;
  }
  throw new StaffModerationStateError(
    'Unresolved moderation state included target-specific data.',
  );
}

function normalizedBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new StaffModerationStateError(
      'Staff moderation-state base URL is invalid.',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StaffModerationStateError(
      'Staff moderation-state base URL must use HTTP or HTTPS.',
    );
  }
  return trimmed;
}

function requireBearer(value: string): string {
  if (value.length >= 32 && value.length <= 512) return value;
  throw new StaffModerationStateError(
    'Staff moderation-state bearer credential is missing or invalid.',
  );
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (Number.isInteger(timeout) && timeout > 0 && timeout <= 30_000) {
    return timeout;
  }
  throw new StaffModerationStateError(
    'Staff moderation-state timeout is invalid.',
  );
}

function requireBoundedContentLength(response: Response): void {
  const raw = response.headers.get('content-length');
  if (raw === null) return;
  const length = Number(raw);
  if (Number.isFinite(length) && length >= 0 && length <= MAX_RESPONSE_BYTES) {
    return;
  }
  throw new StaffModerationStateError(
    'Authoritative moderation-state response exceeded the size bound.',
  );
}
