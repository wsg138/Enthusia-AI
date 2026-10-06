import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AuthorizationError,
  ExternalServiceError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '@enthusia/contracts';
import {
  TICKET_BOT_SERVICE,
  type TicketBotClientConfig,
} from './client.js';
import type {
  TicketEvidenceCapabilities,
  TicketImageEvidence,
} from './types.js';

const evidenceCapabilitiesSchema = z.strictObject({
  service: z.literal('enthusia-support-bot'),
  api: z.literal('ticket-evidence'),
  contractVersion: z.literal('evidence-v1'),
  reads: z.array(z.literal('attachment.image')),
  maxImageBytes: z.number().int().positive().max(8 * 1024 * 1024),
});

type EvidenceMethod = 'GET';

interface EvidenceTarget {
  method: EvidenceMethod;
  path: RegExp;
}

export const TICKET_EVIDENCE_REQUEST_ALLOWLIST: readonly EvidenceTarget[] = [
  { method: 'GET', path: /^\/v1\/evidence\/capabilities$/ },
  {
    method: 'GET',
    path: /^\/v1\/tickets\/[^/]+\/messages\/[^/]+\/attachments\/[^/]+\/image$/,
  },
] as const;

export function assertAllowedEvidenceRequest(
  method: string,
  path: string,
): void {
  const allowed = TICKET_EVIDENCE_REQUEST_ALLOWLIST.some(
    (target) => target.method === method && target.path.test(path),
  );
  if (!allowed) {
    throw new ValidationError(
      `Ticket evidence client refuses ${method} ${path}: only bounded read targets are allowed.`,
    );
  }
}

export class TicketEvidenceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(config: TicketBotClientConfig) {
    if (!config.baseUrl) {
      throw new ValidationError('TicketEvidenceClient requires a baseUrl.');
    }
    if (!config.apiKey) {
      throw new ValidationError('TicketEvidenceClient requires an apiKey.');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl =
      config.fetchImpl ??
      (globalThis.fetch.bind(globalThis) as typeof fetch);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.userAgent =
      config.userAgent ?? 'enthusia-ai/ticket-evidence (+evidence-v1)';
  }

  async getCapabilities(): Promise<TicketEvidenceCapabilities> {
    const raw = await this.getJson('/v1/evidence/capabilities');
    const parsed = evidenceCapabilitiesSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ExternalServiceError(
        TICKET_BOT_SERVICE,
        'Deployed Ticket Bot returned an incompatible evidence capability contract.',
      );
    }
    return parsed.data;
  }

  async getImageEvidence(
    ticketId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<TicketImageEvidence> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.reads.includes('attachment.image')) {
      throw new ExternalServiceError(
        TICKET_BOT_SERVICE,
        'Deployed Ticket Bot does not advertise image evidence reads.',
      );
    }

    const path =
      `/v1/tickets/${encodeURIComponent(ticketId)}` +
      `/messages/${encodeURIComponent(messageId)}` +
      `/attachments/${encodeURIComponent(attachmentId)}/image`;
    const response = await this.getRaw(path);
    return readImageEvidenceResponse(
      response,
      { ticketId, messageId, attachmentId },
      capabilities.maxImageBytes,
    );
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.request(path, 'application/json');
    if (!response.ok) throw await evidenceResponseError(response, path);
    return response.json();
  }

  private async getRaw(path: string): Promise<Response> {
    const response = await this.request(
      path,
      'application/octet-stream, image/*',
    );
    if (!response.ok) throw await evidenceResponseError(response, path);
    return response;
  }

  private async request(path: string, accept: string): Promise<Response> {
    assertAllowedEvidenceRequest('GET', path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': this.userAgent,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ExternalServiceError(
          TICKET_BOT_SERVICE,
          'Ticket evidence request timed out.',
        );
      }
      throw new ExternalServiceError(
        TICKET_BOT_SERVICE,
        'Ticket evidence request failed.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readImageEvidenceResponse(
  response: Response,
  expected: { ticketId: string; messageId: string; attachmentId: string },
  maximumBytes: number,
): Promise<TicketImageEvidence> {
  const contentType = evidenceContentType(response);
  const sha256 = evidenceProvenance(response, expected);
  validateDeclaredEvidenceLength(response, maximumBytes);

  const bytes = new Uint8Array(await response.arrayBuffer());
  validateEvidenceBytes(bytes, maximumBytes);
  validateEvidenceHash(bytes, sha256);

  return {
    ticketId: expected.ticketId,
    messageId: expected.messageId,
    attachmentId: expected.attachmentId,
    contentType,
    size: bytes.byteLength,
    sha256,
    bytes,
  };
}

function evidenceContentType(response: Response): string {
  const value = (response.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (value.startsWith('image/')) return value;
  throw new ExternalServiceError(
    TICKET_BOT_SERVICE,
    'Ticket evidence response was not an image.',
  );
}

function evidenceProvenance(
  response: Response,
  expected: { ticketId: string; messageId: string; attachmentId: string },
): string {
  requireTicketMatch(
    response.headers.get('x-enthusia-ticket-id') ?? '',
    expected.ticketId,
  );
  const messageId = response.headers.get('x-enthusia-message-id') ?? '';
  const attachmentId = response.headers.get('x-enthusia-attachment-id') ?? '';
  if (messageId !== expected.messageId || attachmentId !== expected.attachmentId) {
    throw new ExternalServiceError(
      TICKET_BOT_SERVICE,
      'Ticket evidence provenance did not match the requested attachment.',
    );
  }
  const sha256 = (
    response.headers.get('x-enthusia-content-sha256') ?? ''
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ExternalServiceError(
      TICKET_BOT_SERVICE,
      'Ticket evidence response did not include a valid content hash.',
    );
  }
  return sha256;
}

function requireTicketMatch(actual: string, expected: string): void {
  if (actual === expected || actual === expected.replace(/^T-/i, '')) return;
  throw new ExternalServiceError(
    TICKET_BOT_SERVICE,
    'Ticket evidence provenance did not match the requested ticket.',
  );
}

function validateDeclaredEvidenceLength(
  response: Response,
  maximumBytes: number,
): void {
  const raw = response.headers.get('content-length');
  if (raw === null) return;
  const declared = Number(raw);
  if (Number.isFinite(declared) && declared <= maximumBytes) return;
  throw new ExternalServiceError(
    TICKET_BOT_SERVICE,
    'Ticket evidence response exceeded the advertised size limit.',
  );
}

function validateEvidenceBytes(
  bytes: Uint8Array,
  maximumBytes: number,
): void {
  if (bytes.byteLength >= 1 && bytes.byteLength <= maximumBytes) return;
  throw new ExternalServiceError(
    TICKET_BOT_SERVICE,
    'Ticket evidence response exceeded the advertised size limit.',
  );
}

function validateEvidenceHash(
  bytes: Uint8Array,
  expectedHash: string,
): void {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual === expectedHash) return;
  throw new ExternalServiceError(
    TICKET_BOT_SERVICE,
    'Ticket evidence content hash did not match its provenance header.',
  );
}

async function evidenceResponseError(
  response: Response,
  path: string,
): Promise<Error> {
  const detail = await safeErrorBody(response);
  if (response.status === 401 || response.status === 403) {
    return new AuthorizationError(
      `Ticket Bot denied GET ${path}: ${detail}`,
    );
  }
  if (response.status === 404) {
    return new NotFoundError(`Ticket evidence was not found: ${detail}`);
  }
  if (response.status === 429) {
    return new RateLimitError('Ticket Bot evidence rate limit exceeded.');
  }
  return new ExternalServiceError(
    TICKET_BOT_SERVICE,
    `GET ${path} failed with status ${response.status}: ${detail}`,
  );
}

async function safeErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300) || response.statusText;
  } catch {
    return response.statusText;
  }
}
