/**
 * @enthusia/integration-ticket-bot — typed Ticket Bot API client (W14).
 *
 * Spec: MASTER-SPECIFICATION.md §20 (Ticket Bot separation).
 *
 * CRITICAL INVARIANT: the Ticket Bot remains the source of truth for
 * ticket state and permissions. Enthusia AI REQUESTS actions; the Ticket
 * Bot validates and executes them. This client therefore exposes only:
 *
 *   - reads: ticket, messages, participants, action-request status
 *   - action requests: POST /v1/tickets/{id}/actions/request
 *
 * Direct state mutation through this client is impossible by construction:
 * `assertAllowedRequest` (below) allowlists every HTTP method+path the
 * client may issue. No PUT/PATCH/DELETE target exists anywhere in this
 * module, and any non-allowlisted request throws before a socket is opened.
 * The unit tests pin this invariant (see test/ticket-bot.test.ts).
 */

import {
  AuthorizationError,
  ConflictError,
  EnthusiaError,
  ExternalServiceError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '@enthusia/contracts';
import type {
  ActionRequestInput,
  ActionRequestKind,
  ActionRequestParameters,
  ActionRequestResult,
  ActionRequestStatus,
  ListMessagesOptions,
  ListTicketsOptions,
  Paginated,
  Ticket,
  TicketContextBundle,
  TicketContextFetchOptions,
  TicketMessage,
  TicketParticipant,
  TicketStatus,
} from './types.js';

export type {
  ActionRequestInput,
  ActionRequestKind,
  ActionRequestParameters,
  ActionRequestResult,
  ActionRequestStatus,
  ListMessagesOptions,
  ListTicketsOptions,
  Paginated,
  Ticket,
  TicketContextBundle,
  TicketContextFetchOptions,
  TicketMessage,
  TicketParticipant,
  TicketStatus,
};

/** Identity Enthusia AI presents to the Ticket Bot in action requests. */
export const AI_REQUESTED_BY = 'enthusia-ai/ticket-integration';

/** Service name used in error provenance. */
export const TICKET_BOT_SERVICE = 'ticket-bot';

export interface TicketBotClientConfig {
  /** Base URL of the Ticket Bot service API, e.g. https://tickets.internal. */
  baseUrl: string;
  /** API key sent as a Bearer token. Never logged or embedded in errors. */
  apiKey: string;
  /** Fetch implementation (injectable for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** User-Agent header value. */
  userAgent?: string;
}

type AllowedMethod = 'GET' | 'POST';

interface AllowedTarget {
  method: AllowedMethod;
  /** Matches the URL path (without query string). */
  path: RegExp;
}

/**
 * Complete allowlist of HTTP targets the client may issue.
 *
 * Reads are GETs against ticket-scoped resources. The ONLY mutating-shaped
 * call is POST /v1/tickets/{id}/actions/request — a *request* the Ticket
 * Bot validates and executes (§20.2), not a direct state change.
 *
 * Anything else — PUT/PATCH/DELETE anywhere, POST to any other path,
 * GETs outside /v1/tickets* or /v1/actions/requests* — is rejected by
 * `assertAllowedRequest` before any network I/O.
 */
export const TICKET_BOT_REQUEST_ALLOWLIST: readonly AllowedTarget[] = [
  { method: 'GET', path: /^\/v1\/tickets$/ },
  { method: 'GET', path: /^\/v1\/tickets\/[^/]+$/ },
  { method: 'GET', path: /^\/v1\/tickets\/[^/]+\/messages$/ },
  { method: 'GET', path: /^\/v1\/tickets\/[^/]+\/participants$/ },
  { method: 'POST', path: /^\/v1\/tickets\/[^/]+\/actions\/request$/ },
  { method: 'GET', path: /^\/v1\/actions\/requests\/[^/]+$/ },
] as const;

/**
 * Enforces the no-mutation invariant. Throws a ValidationError for any
 * method+path not on {@link TICKET_BOT_REQUEST_ALLOWLIST}.
 *
 * Exported so tests (and future callers) can pin the invariant directly.
 */
export function assertAllowedRequest(method: string, path: string): void {
  const ok = TICKET_BOT_REQUEST_ALLOWLIST.some(
    (t) => t.method === method && t.path.test(path),
  );
  if (!ok) {
    throw new ValidationError(
      `Ticket Bot client refuses ${method} ${path}: not an allowlisted read or action request. ` +
        'Direct ticket mutation is forbidden; request actions through the Ticket Bot instead.',
    );
  }
}

function randomCorrelationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class TicketBotClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(config: TicketBotClientConfig) {
    if (!config.baseUrl) {
      throw new ValidationError('TicketBotClient requires a baseUrl.');
    }
    if (!config.apiKey) {
      throw new ValidationError('TicketBotClient requires an apiKey.');
    }
    // Normalize: no trailing slash so path joins are predictable.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl =
      config.fetchImpl ??
      (globalThis.fetch.bind(globalThis) as typeof fetch);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.userAgent = config.userAgent ?? 'enthusia-ai/ticket-integration (+w14)';
  }

  /** Fetch one ticket by id (read-only). */
  async getTicket(ticketId: string): Promise<Ticket> {
    return this.get<Ticket>(`/v1/tickets/${encodeURIComponent(ticketId)}`);
  }

  /** List tickets with optional filters (read-only). */
  async listTickets(options: ListTicketsOptions = {}): Promise<Paginated<Ticket>> {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.ownerId) params.set('owner_id', options.ownerId);
    if (options.assigneeId) params.set('assignee_id', options.assigneeId);
    if (options.category) params.set('category', options.category);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.cursor) params.set('cursor', options.cursor);
    const query = params.toString();
    return this.get<Paginated<Ticket>>(`/v1/tickets${query ? `?${query}` : ''}`);
  }

  /** Fetch transcript messages for a ticket (read-only). */
  async getTicketMessages(
    ticketId: string,
    options: ListMessagesOptions = {},
  ): Promise<Paginated<TicketMessage>> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.cursor) params.set('cursor', options.cursor);
    const query = params.toString();
    return this.get<Paginated<TicketMessage>>(
      `/v1/tickets/${encodeURIComponent(ticketId)}/messages${query ? `?${query}` : ''}`,
    );
  }

  /** Fetch participants for a ticket (read-only). */
  async getTicketParticipants(ticketId: string): Promise<TicketParticipant[]> {
    return this.get<TicketParticipant[]>(
      `/v1/tickets/${encodeURIComponent(ticketId)}/participants`,
    );
  }

  /**
   * Fetch the full context bundle (ticket + recent messages + participants)
   * used by the ticket-context adapter. Reads only.
   */
  async getTicketContext(
    ticketId: string,
    options: TicketContextFetchOptions = {},
  ): Promise<TicketContextBundle> {
    const maxMessages = Math.min(Math.max(options.maxMessages ?? 20, 1), 100);
    const includeParticipants = options.includeParticipants ?? true;
    const encoded = encodeURIComponent(ticketId);
    const [ticket, messagesPage, participants] = await Promise.all([
      this.get<Ticket>(`/v1/tickets/${encoded}`),
      this.get<Paginated<TicketMessage>>(
        `/v1/tickets/${encoded}/messages?limit=${maxMessages}`,
      ),
      includeParticipants
        ? this.get<TicketParticipant[]>(`/v1/tickets/${encoded}/participants`)
        : Promise.resolve([] as TicketParticipant[]),
    ]);
    return {
      ticket,
      messages: messagesPage.items,
      participants,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Submit an action REQUEST to the Ticket Bot.
   *
   * This is a request, not a mutation: the Ticket Bot validates
   * permissions, state, confirmation, concurrency, and transcript/archive
   * rules (§20.2) and returns an accepted/rejected/superseded/expired
   * {@link ActionRequestResult}. Poll with {@link getActionRequest} if the
   * request stays pending.
   */
  async requestAction(
    ticketId: string,
    input: ActionRequestInput,
  ): Promise<ActionRequestResult> {
    if (!input.reason || input.reason.trim().length === 0) {
      throw new ValidationError('Action requests require a non-empty reason.');
    }
    const body = {
      action: input.action,
      reason: input.reason,
      requested_by: AI_REQUESTED_BY,
      correlation_id: input.correlationId ?? randomCorrelationId(),
      parameters: input.parameters ?? {},
    };
    return this.post<ActionRequestResult>(
      `/v1/tickets/${encodeURIComponent(ticketId)}/actions/request`,
      body,
    );
  }

  /** Convenience: request that the Ticket Bot close a ticket. */
  async requestClose(
    ticketId: string,
    reason: string,
    correlationId?: string,
  ): Promise<ActionRequestResult> {
    return this.requestAction(ticketId, {
      action: 'close',
      reason,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
  }

  /** Convenience: request that the Ticket Bot reopen a ticket. */
  async requestReopen(
    ticketId: string,
    reason: string,
    correlationId?: string,
  ): Promise<ActionRequestResult> {
    return this.requestAction(ticketId, {
      action: 'reopen',
      reason,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
  }

  /**
   * Convenience: request escalation to a staff member (or the staff queue
   * when assigneeId is omitted).
   */
  async requestEscalation(
    ticketId: string,
    reason: string,
    options: { assigneeId?: string; correlationId?: string } = {},
  ): Promise<ActionRequestResult> {
    const parameters: ActionRequestParameters = {};
    if (options.assigneeId !== undefined) {
      parameters.assigneeId = options.assigneeId;
    }
    return this.requestAction(ticketId, {
      action: 'escalate',
      reason,
      parameters,
      ...(options.correlationId !== undefined
        ? { correlationId: options.correlationId }
        : {}),
    });
  }

  /** Convenience: request that the Ticket Bot append a staff-visible note. */
  async requestAddNote(
    ticketId: string,
    note: string,
    reason: string,
    correlationId?: string,
  ): Promise<ActionRequestResult> {
    return this.requestAction(ticketId, {
      action: 'add_note',
      reason,
      parameters: { note },
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
  }

  /** Poll the status of a previously submitted action request (read-only). */
  async getActionRequest(requestId: string): Promise<ActionRequestResult> {
    return this.get<ActionRequestResult>(
      `/v1/actions/requests/${encodeURIComponent(requestId)}`,
    );
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private async get<T>(pathWithQuery: string): Promise<T> {
    const { path } = splitPath(pathWithQuery);
    assertAllowedRequest('GET', path);
    return this.send<T>('GET', pathWithQuery, undefined);
  }

  private async post<T>(pathWithQuery: string, body: unknown): Promise<T> {
    const { path } = splitPath(pathWithQuery);
    assertAllowedRequest('POST', path);
    return this.send<T>('POST', pathWithQuery, body);
  }

  private async send<T>(
    method: 'GET' | 'POST',
    pathWithQuery: string,
    body: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': this.userAgent,
    };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathWithQuery}`, init);
    } catch (err) {
      throw toTicketBotError(err);
    } finally {
      clearTimeout(timer);
    }
    return this.handleResponse<T>(response, method, pathWithQuery);
  }

  private async handleResponse<T>(
    response: Response,
    method: string,
    pathWithQuery: string,
  ): Promise<T> {
    const { path } = splitPath(pathWithQuery);
    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    }
    const detail = await safeErrorBody(response);
    switch (response.status) {
      case 400:
        throw new ValidationError(`Ticket Bot rejected the request: ${detail}`);
      case 401:
      case 403:
        throw new AuthorizationError(
          `Ticket Bot denied the ${method} ${path} request: ${detail}`,
        );
      case 404:
        throw new NotFoundError(`Ticket Bot resource not found: ${detail}`);
      case 409:
        throw new ConflictError(`Ticket Bot reported a conflict: ${detail}`);
      case 429:
        throw new RateLimitError('Ticket Bot rate limit exceeded.');
      default:
        throw new ExternalServiceError(
          TICKET_BOT_SERVICE,
          `${method} ${path} failed with status ${response.status}: ${detail}`,
        );
    }
  }
}

function splitPath(pathWithQuery: string): { path: string } {
  const q = pathWithQuery.indexOf('?');
  return { path: q === -1 ? pathWithQuery : pathWithQuery.slice(0, q) };
}

async function safeErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    // Cap length; never echo credentials (the key only travels in headers,
    // which we never serialize, but keep the body short regardless).
    return text.slice(0, 300) || response.statusText;
  } catch {
    return response.statusText;
  }
}

function toTicketBotError(err: unknown): EnthusiaError {
  if (err instanceof EnthusiaError) {
    return err;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new ExternalServiceError(
      TICKET_BOT_SERVICE,
      'Request timed out.',
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  // Defensive: strip anything that looks like a bearer token from the message.
  const scrubbed = message.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/g, 'Bearer [redacted]');
  return new ExternalServiceError(TICKET_BOT_SERVICE, scrubbed);
}
