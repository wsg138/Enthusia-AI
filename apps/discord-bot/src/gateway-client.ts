/**
 * @enthusia/discord-bot — AI Gateway client (W06).
 *
 * The bot core is a thin surface: it builds a `ChatRequest` (§48.1) and
 * hands it to the AI Gateway (W02) over HTTP. Reasoning, memory, tools, and
 * escalation all live downstream — this module MUST NOT grow any of those.
 *
 * `MockAiGatewayClient` remains available for tests/local development only.
 * Production startup rejects mock mode.
 */
import {
  TRACE_ID_HEADER,
  agentResponseSchema,
  chatRequestSchema,
  type AgentResponse,
  type ChatRequest,
} from '@enthusia/contracts';
import { EnthusiaError, ExternalServiceError, RateLimitError, ToolTimeoutError, ValidationError } from '@enthusia/contracts';
import type { EnthusiaLogger } from '@enthusia/logging';

import type { DiscordBotOptions } from './config.js';

/**
 * Map the zod-validated wire shape onto the compile-time `AgentResponse`.
 * The two are structurally identical except for optional-with-`undefined`
 * fields, which `exactOptionalPropertyTypes` treats strictly; the explicit
 * mapping keeps the boundary honest.
 */
function toAgentResponse(data: {
  text: string;
  actions: { type: string; payload?: Record<string, unknown> | undefined }[];
  sources: { artifactId?: string | undefined; description: string; visibility: AgentResponse['sources'][number]['visibility'] }[];
  memoryUpdates: AgentResponse['memoryUpdates'];
  escalation: {
    reason: string;
    target: 'human' | 'strong-model';
    context?: Record<string, unknown> | undefined;
  } | null;
  traceId: string;
  outcome?: 'answered' | 'unverified' | 'error' | undefined;
}): AgentResponse {
  return {
    text: data.text,
    actions: data.actions.map((action) => ({
      type: action.type,
      ...(action.payload === undefined ? {} : { payload: action.payload }),
    })),
    sources: data.sources.map((source) => ({
      description: source.description,
      visibility: source.visibility,
      ...(source.artifactId === undefined ? {} : { artifactId: source.artifactId }),
    })),
    memoryUpdates: data.memoryUpdates.map((update) => ({ ...update })),
    escalation:
      data.escalation === null
        ? null
        : {
            reason: data.escalation.reason,
            target: data.escalation.target,
            ...(data.escalation.context === undefined ? {} : { context: data.escalation.context }),
          },
    traceId: data.traceId,
    ...(data.outcome !== undefined ? { outcome: data.outcome } : {}),
  };
}

/** Minimal gateway surface the bot needs. */
export interface AiGatewayClient {
  sendChat(request: ChatRequest): Promise<AgentResponse>;
}

/**
 * HTTP client for the AI Gateway (W02).
 *
 * Assumed contract (TODO(W02): confirm against the gateway workstream):
 *   POST {baseUrl}/v1/chat
 *   - request body: ChatRequest JSON (§48.1)
 *   - request header: x-enthusia-trace-id (trace propagation, §36)
 *   - response body: AgentResponse JSON (§48.2)
 *
 * The response is validated against the contracts schema; a malformed
 * response is a ValidationError, transport failures are
 * ExternalServiceError, and timeouts are ToolTimeoutError. Only
 * visibility-safe messages cross into user-facing fallbacks (see bot.ts).
 */
export class HttpAiGatewayClient implements AiGatewayClient {
  private readonly chatUrl: string;

  constructor(
    gatewayBaseUrl: string,
    private readonly timeoutMs: number,
    private readonly logger?: EnthusiaLogger,
    private readonly apiKey?: string,
  ) {
    this.chatUrl = `${gatewayBaseUrl.replace(/\/+$/, '')}/v1/chat`;
  }

  async sendChat(request: ChatRequest): Promise<AgentResponse> {
    // Fail fast on our own malformed requests — never send garbage downstream.
    const body = chatRequestSchema.parse(request);
    const traceId = body.traceId ?? 'unknown';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      this.logger?.debug(
        { traceId, url: this.chatUrl },
        'sending ChatRequest to AI Gateway',
      );
      const response = await fetch(this.chatUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TRACE_ID_HEADER]: traceId,
          ...(this.apiKey !== undefined ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger?.warn({ traceId, gatewayStatus: response.status }, 'AI Gateway returned a failed HTTP status');
        if (response.status === 429) {
          const rawRetry = Number(response.headers.get('retry-after'));
          const retryAfter = Number.isInteger(rawRetry) && rawRetry > 0 && rawRetry <= 300
            ? rawRetry : undefined;
          throw new RateLimitError('AI Gateway is busy. Please try again shortly.', retryAfter, { traceId });
        }
        if (response.status === 504) {
          throw new ToolTimeoutError('ai-gateway', this.timeoutMs, { traceId });
        }
        throw new ExternalServiceError('ai-gateway', `AI Gateway responded with HTTP ${response.status}`, {
          traceId,
          detail: { status: response.status },
        });
      }
      const json: unknown = await response.json();
      const parsed = agentResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new ValidationError('AI Gateway returned a malformed AgentResponse', {
          traceId,
          detail: parsed.error.flatten(),
        });
      }
      return toAgentResponse(parsed.data);
    } catch (error) {
      if (error instanceof EnthusiaError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ToolTimeoutError('ai-gateway', this.timeoutMs, { traceId, cause: error });
      }
      throw new ExternalServiceError('ai-gateway', 'AI Gateway request failed', { traceId, cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * In-process stub used until W02 (AI Gateway) is available.
 *
 * Returns a deterministic, clearly-labeled canned response so integration
 * tests can verify the full Discord → gateway → Discord path without any
 * network. NOT for production use.
 *
 * TODO(W02): remove once the real gateway is live; flip
 * `useMockGateway` default to false in config.ts.
 */
export class MockAiGatewayClient implements AiGatewayClient {
  async sendChat(request: ChatRequest): Promise<AgentResponse> {
    const preview = request.message.length > 120 ? `${request.message.slice(0, 120)}…` : request.message;
    return {
      text:
        `[mock gateway] I received your message as ${request.actor.displayName ?? request.actor.id} ` +
        `(${request.actor.type}) in \`${request.conversationId}\`:\n\n> ${preview}\n\n` +
        `The real AI Gateway (W02) is not connected yet, so this is a stub response. ` +
        `Trace: \`${request.traceId ?? 'none'}\`.`,
      actions: [],
      sources: [],
      memoryUpdates: [],
      escalation: null,
      traceId: request.traceId ?? 'mock-no-trace',
    };
  }
}

/** Build the configured gateway client (mock until W02 lands). */
export function createGatewayClient(
  options: DiscordBotOptions,
  logger?: EnthusiaLogger,
): AiGatewayClient {
  if (options.useMockGateway) {
    logger?.warn('using MockAiGatewayClient — set ENTHUSIA_DISCORD_USE_MOCK_GATEWAY=false once W02 lands');
    return new MockAiGatewayClient();
  }
  return new HttpAiGatewayClient(
    options.gatewayBaseUrl,
    options.gatewayTimeoutMs,
    logger,
    options.gatewayApiKey,
  );
}
