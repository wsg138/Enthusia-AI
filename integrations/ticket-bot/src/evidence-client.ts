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
  TicketVideoEvidence,
} from './types.js';

const evidenceCapabilitiesV1Schema = z.strictObject({
  service: z.literal('enthusia-support-bot'),
  api: z.literal('ticket-evidence'),
  contractVersion: z.literal('evidence-v1'),
  reads: z.array(z.literal('attachment.image')),
  maxImageBytes: z.number().int().positive().max(8 * 1024 * 1024),
});

const evidenceCapabilitiesV2Schema = z.strictObject({
  service: z.literal('enthusia-support-bot'),
  api: z.literal('ticket-evidence'),
  contractVersion: z.literal('evidence-v2'),
  reads: z.array(z.enum(['attachment.image', 'attachment.video'])),
  maxImageBytes: z.number().int().positive().max(8 * 1024 * 1024),
  maxVideoBytes: z.number().int().positive().max(25 * 1024 * 1024),
});

const evidenceCapabilitiesSchema = z.union([
  evidenceCapabilitiesV1Schema,
  evidenceCapabilitiesV2Schema,
]);

const SUPPORTED_VIDEO_TYPES = new Set<TicketVideoEvidence['contentType']>([
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

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
  {
    method: 'GET',
    path: /^\/v1\/tickets\/[^/]+\/messages\/[^/]+\/attachments\/[^/]+\/video$/,
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

function requiredBaseUrl(value: string): string {
  if (value) return value.replace(/\/+$/, '');
  throw new ValidationError('TicketEvidenceClient requires a baseUrl.');
}

function requiredApiKey(value: string): string {
  if (value) return value;
  throw new ValidationError('TicketEvidenceClient requires an apiKey.');
}

export class TicketEvidenceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(config: TicketBotClientConfig) {
    this.baseUrl = requiredBaseUrl(config.baseUrl);
    this.apiKey = requiredApiKey(config.apiKey);
    this.fetchImpl =
      config.fetchImpl ??
      (globalThis.fetch.bind(globalThis) as typeof fetch);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.userAgent =
      config.userAgent ?? 'enthusia-ai/ticket-evidence (+evidence-v2)';
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
    requireImageReadCapability(capabilities);

    const path =
      `/v1/tickets/${encodeURIComponent(ticketId)}` +
      `/messages/${encodeURIComponent(messageId)}` +
      `/attachments/${encodeURIComponent(attachmentId)}/image`;
    const response = await this.getRaw(
      path,
      'application/octet-stream, image/*',
    );
    return readImageEvidenceResponse(
      response,
      { ticketId, messageId, attachmentId },
      capabilities.maxImageBytes,
    );
  }

  async getVideoEvidence(
    ticketId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<TicketVideoEvidence> {
    const capabilities = await this.getCapabilities();
    requireVideoReadCapability(capabilities);

    const path =
      `/v1/tickets/${encodeURIComponent(ticketId)}` +
      `/messages/${encodeURIComponent(messageId)}` +
      `/attachments/${encodeURIComponent(attachmentId)}/video`;
    const response = await this.getRaw(
      path,
      'application/octet-stream, video/mp4, video/webm, video/quicktime',
    );
    return readVideoEvidenceResponse(
      response,
      { ticketId, messageId, attachmentId },
      videoByteLimit(capabilities),
    );
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.request(path, 'application/json');
    if (!response.ok) throw await evidenceResponseError(response, path);
    return response.json();
  }

  private async getRaw(path: string, accept: string): Promise<Response> {
    const response = await this.request(path, accept);
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
      throw evidenceTransportError(error);
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
  const contentType = imageContentType(response);
  const common = await readEvidenceResponse(
    response,
    expected,
    maximumBytes,
  );
  return { ...common, contentType };
}

async function readVideoEvidenceResponse(
  response: Response,
  expected: { ticketId: string; messageId: string; attachmentId: string },
  maximumBytes: number,
): Promise<TicketVideoEvidence> {
  const contentType = videoContentType(response);
  const common = await readEvidenceResponse(
    response,
    expected,
    maximumBytes,
  );
  return { ...common, contentType };
}

async function readEvidenceResponse(
  response: Response,
  expected: { ticketId: string; messageId: string; attachmentId: string },
  maximumBytes: number,
): Promise<Omit<TicketImageEvidence, 'contentType'>> {
  const sha256 = evidenceProvenance(response, expected);
  validateDeclaredEvidenceLength(response, maximumBytes);

  const bytes = new Uint8Array(await response.arrayBuffer());
  validateEvidenceBytes(bytes, maximumBytes);
  validateEvidenceHash(bytes, sha256);

  return {
    ticketId: expected.ticketId,
    messageId: expected.messageId,
    attachmentId: expected.attachmentId,
    size: bytes.byteLength,
    sha256,
    bytes,
  };
}

function responseContentType(response: Response): string {
  const [rawType = ''] = (response.headers.get('content-type') ?? '').split(';');
  return rawType.trim().toLowerCase();
}

function imageContentType(response: Response): string {
  const value = responseContentType(response);
  if (value.startsWith('image/')) return value;
  throw new ExternalServiceError(
    TICKET_BOT_SERVICE,
    'Ticket evidence response was not an image.',
  );
}

function videoContentType(response: Response): TicketVideoEvidence['contentType'] {
  const value = responseContentType(response);
  if (SUPPORTED_VIDEO_TYPES.has(value as TicketVideoEvidence['contentType'])) {
    return value as TicketVideoEvidence['contentType'];
  }
  throw new ExternalServiceError(
    TICKET_BOT_SERVICE,
    'Ticket evidence response was not a supported video.',
  );
}

function evidenceProvenance(
  response: Response,
  expected: { ticketId: string; messageId: string; attachmentId: string },
): string {
  const actual = readEvidenceProvenanceHeaders(response);
  requireTicketMatch(actual.ticketId, expected.ticketId);
  requireAttachmentMatch(actual, expected);
  return requireSha256(actual.sha256);
}

function readEvidenceProvenanceHeaders(response: Response): {
  ticketId: string;
  messageId: string;
  attachmentId: string;
  sha256: string;
} {
  return {
    ticketId: response.headers.get('x-enthusia-ticket-id') ?? '',
    messageId: response.headers.get('x-enthusia-message-id') ?? '',
    attachmentId: response.headers.get('x-enthusia-attachment-id') ?? '',
    sha256: (
      response.headers.get('x-enthusia-content-sha256') ?? ''
    ).toLowerCase(),
  };
}

function requireAttachmentMatch(
  actual: { messageId: string; attachmentId: string },
  expected: { messageId: string; attachmentId: string },
): void {
  if (
    actual.messageId === expected.messageId &&
    actual.attachmentId === expected.attachmentId
  ) {
    return;
  }
  throw new ExternalServiceError(
    TICKET_BOT_SERVICE,
    'Ticket evidence provenance did not match the requested attachment.',
  );
}

function requireSha256(value: string): string {
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  throw new ExternalServiceError(
    TICKET_BOT_SERVICE,
    'Ticket evidence response did not include a valid content hash.',
  );
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
  switch (response.status) {
    case 401:
    case 403:
      return new AuthorizationError(
        `Ticket Bot denied GET ${path}: ${detail}`,
      );
    case 404:
      return new NotFoundError(`Ticket evidence was not found: ${detail}`);
    case 429:
      return new RateLimitError('Ticket Bot evidence rate limit exceeded.');
    default:
      return new ExternalServiceError(
        TICKET_BOT_SERVICE,
        `GET ${path} failed with status ${response.status}: ${detail}`,
      );
  }
}

function requireImageReadCapability(
  capabilities: TicketEvidenceCapabilities,
): void {
  if (capabilities.reads.includes('attachment.image')) return;
  throw new ExternalServiceError(
    TICKET_BOT_SERVICE,
    'Deployed Ticket Bot does not advertise image evidence reads.',
  );
}

function requireVideoReadCapability(
  capabilities: TicketEvidenceCapabilities,
): void {
  if (
    capabilities.contractVersion === 'evidence-v2' &&
    capabilities.reads.includes('attachment.video')
  ) {
    return;
  }
  throw new ExternalServiceError(
    TICKET_BOT_SERVICE,
    'Deployed Ticket Bot does not advertise video evidence reads.',
  );
}

function videoByteLimit(
  capabilities: TicketEvidenceCapabilities,
): number {
  requireVideoReadCapability(capabilities);
  if (capabilities.contractVersion !== 'evidence-v2') {
    throw new ExternalServiceError(
      TICKET_BOT_SERVICE,
      'Deployed Ticket Bot video evidence contract is unavailable.',
    );
  }
  return capabilities.maxVideoBytes;
}

function evidenceTransportError(error: unknown): ExternalServiceError {
  const detail =
    error instanceof Error && error.name === 'AbortError'
      ? 'Ticket evidence request timed out.'
      : 'Ticket evidence request failed.';
  return new ExternalServiceError(TICKET_BOT_SERVICE, detail);
}

async function safeErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300) || response.statusText;
  } catch {
    return response.statusText;
  }
}
