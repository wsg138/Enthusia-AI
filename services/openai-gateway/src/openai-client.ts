/**
 * @enthusia/openai-gateway — OpenAI chat completions integration (W13).
 *
 * Minimal dependency-free client (global fetch) so the gateway has no
 * SDK surface to keep in sync. The base URL is configurable so tests run
 * against a local mock server; production uses api.openai.com.
 *
 * The API key is read from configuration only and is NEVER logged, echoed
 * in errors, or persisted by this module.
 */
import { estimateTokens, type ChatMessage } from './packet-format.js';

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResult {
  model: string;
  content: string;
  finishReason: string;
  usage: TokenUsage;
}

export class OpenAIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAIError';
  }
}

/** The request exceeded the configured timeout. */
export class OpenAITimeoutError extends OpenAIError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`OpenAI request timed out after ${timeoutMs}ms`);
    this.name = 'OpenAITimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** The API answered with a non-2xx status (or an error envelope). */
export class OpenAIApiError extends OpenAIError {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`OpenAI API error ${status} (${code}): ${message}`);
    this.name = 'OpenAIApiError';
    this.status = status;
    this.code = code;
  }
}

/** The API response could not be parsed into a completion. */
export class OpenAIParseError extends OpenAIError {
  constructor(detail: string) {
    super(`Could not parse OpenAI response: ${detail}`);
    this.name = 'OpenAIParseError';
  }
}

interface WireError {
  message?: unknown;
  code?: unknown;
  type?: unknown;
}

interface WireResponse {
  model?: unknown;
  choices?: Array<{
    message?: { content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  error?: WireError;
}

export interface OpenAIClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** Inject a fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const MAX_ERROR_BODY_CHARS = 2000;

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseErrorBody(text: string): { code: string; message: string } {
  try {
    const parsed = JSON.parse(text) as { error?: WireError };
    const error = parsed.error;
    const message =
      typeof error?.message === 'string' && error.message.length > 0
        ? error.message
        : 'unknown error';
    const code =
      typeof error?.code === 'string' && error.code.length > 0
        ? error.code
        : typeof error?.type === 'string' && error.type.length > 0
          ? error.type
          : 'unknown';
    return { code, message };
  } catch {
    return { code: 'unparseable', message: text.slice(0, MAX_ERROR_BODY_CHARS) };
  }
}

export class OpenAIClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chatCompletions(
    options: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // NOTE: the key travels only in this header; never in logs/errors.
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          ...(options.maxOutputTokens !== undefined
            ? { max_tokens: options.maxOutputTokens }
            : {}),
          ...(options.temperature !== undefined
            ? { temperature: options.temperature }
            : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OpenAITimeoutError(this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const parsed = parseErrorBody(text);
      throw new OpenAIApiError(response.status, parsed.code, parsed.message);
    }

    let wire: WireResponse;
    try {
      wire = (await response.json()) as WireResponse;
    } catch {
      throw new OpenAIParseError('response body is not valid JSON');
    }

    if (wire.error !== undefined) {
      const parsed = parseErrorBody(JSON.stringify({ error: wire.error }));
      throw new OpenAIApiError(response.status, parsed.code, parsed.message);
    }

    const choice =
      Array.isArray(wire.choices) && wire.choices.length > 0
        ? wire.choices[0]
        : undefined;
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new OpenAIParseError('no assistant content in choices[0].message');
    }

    const model = typeof wire.model === 'string' ? wire.model : options.model;
    const finishReason =
      typeof choice?.finish_reason === 'string'
        ? choice.finish_reason
        : 'unknown';

    const promptTokens =
      asNumber(wire.usage?.prompt_tokens) ??
      estimateTokens(
        options.messages.map((m) => m.content).join('\n'),
      );
    const completionTokens =
      asNumber(wire.usage?.completion_tokens) ?? estimateTokens(content);
    const totalTokens =
      asNumber(wire.usage?.total_tokens) ?? promptTokens + completionTokens;

    return {
      model,
      content,
      finishReason,
      usage: { promptTokens, completionTokens, totalTokens },
    };
  }
}
