import { setTimeout as sleep } from 'node:timers/promises';
import {
  ExternalServiceError,
  ToolTimeoutError,
  ValidationError,
  type EnthusiaErrorOptions,
} from '@enthusia/contracts';
import { createLogger, type EnthusiaLogger } from '@enthusia/logging';
import { buildCapabilities, enforceContextLimits } from './capabilities.js';
import type { InferenceConfig } from './config.js';
import { InferenceMetrics, type MetricsSnapshot } from './metrics.js';
import {
  chatCompletionChunkSchema,
  chatCompletionResponseSchema,
  generationRequestSchema,
  modelsResponseSchema,
  toModelInfo,
  type GenerationRequest,
  type GenerationResult,
  type ModelCapabilities,
  type ModelInfo,
  type ParsedGenerationRequest,
  type StreamDelta,
} from './types.js';

/**
 * @enthusia/inference-adapter — OpenAI-compatible inference HTTP client.
 *
 * W03 owns this client. No other package may issue HTTP calls to the
 * inference runtime: the runtime is swappable precisely because every caller
 * goes through this adapter's typed surface.
 *
 * Guarantees:
 * - every attempt has a bounded timeout (default 120s, configurable);
 * - retryable failures (HTTP 5xx, 429, network errors) are retried with
 *   exponential backoff + jitter, at most `inferenceMaxRetries` retries;
 * - client errors (other 4xx), timeouts, and validation failures are NOT
 *   retried by this client (timeouts surface as ToolTimeoutError, which
 *   callers may retry at their own layer);
 * - in-flight concurrency is bounded by `inferenceConcurrency` (§9.2); the
 *   queue depth is exposed via metrics.
 */

export interface RequestOptions {
  /** Abort the request from the caller side (combined with the client timeout). */
  signal?: AbortSignal;
  /** Correlation ID for logs and typed errors. */
  traceId?: string | undefined;
  /** Override the configured per-attempt timeout for this call. */
  timeoutMs?: number;
}

export interface InferenceClientOptions {
  config: InferenceConfig;
  logger?: EnthusiaLogger;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Shared metrics registry (tests / embedding services). */
  metrics?: InferenceMetrics;
}

/** Marks an upstream failure the client is allowed to retry. */
class RetryableUpstreamError extends ExternalServiceError {
  constructor(service: string, message: string, options: EnthusiaErrorOptions = {}) {
    super(service, message, options);
  }
}

/**
 * Build error options without ever assigning explicit `undefined`
 * (the repo compiles with `exactOptionalPropertyTypes`).
 */
function errOpts(traceId?: string, detail?: unknown): EnthusiaErrorOptions {
  const opts: EnthusiaErrorOptions = {};
  if (traceId !== undefined) opts.traceId = traceId;
  if (detail !== undefined) opts.detail = detail;
  return opts;
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return (
      typeof code === 'string' &&
      ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(code)
    );
  }
  return false;
}

/** Bounded semaphore for the inference concurrency gate. */
class Semaphore {
  private available: number;
  private readonly waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error('Inference request aborted while queued'));
      };
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      const wrappedResolve = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      waiter.resolve = wrappedResolve;
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve();
    } else {
      this.available += 1;
    }
  }
}

function backoffDelayMs(attemptIndex: number, baseMs: number, maxMs: number): number {
  const exponential = baseMs * 2 ** attemptIndex;
  const capped = Math.min(maxMs, exponential);
  // Equal jitter: 50% deterministic + 50% random — avoids thundering-herd
  // retries against a recovering server while staying test-friendly.
  return capped * (0.5 + Math.random() * 0.5);
}

async function* parseSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // HTTP/SSE producers commonly use CRLF. Normalize framing before
      // looking for the blank line that terminates an SSE event.
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of event.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            yield trimmed.slice('data:'.length).trim();
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    const remainder = buffer.trim();
    if (remainder.startsWith('data:')) {
      yield remainder.slice('data:'.length).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

export class InferenceClient {
  private readonly config: InferenceConfig;
  private readonly logger: EnthusiaLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly metrics: InferenceMetrics;
  private readonly semaphore: Semaphore;
  private readonly capabilities: ModelCapabilities;

  constructor(options: InferenceClientOptions) {
    this.config = options.config;
    this.logger =
      options.logger ?? createLogger({ name: 'inference-adapter', level: options.config.logLevel });
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.metrics = options.metrics ?? new InferenceMetrics();
    this.semaphore = new Semaphore(options.config.inferenceConcurrency);
    this.capabilities = buildCapabilities(options.config);
  }

  getCapabilities(): ModelCapabilities {
    return { ...this.capabilities };
  }

  getMetrics(): MetricsSnapshot {
    return this.metrics.snapshot();
  }

  private baseUrl(): string {
    return this.config.inferenceBaseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.inferenceApiKey !== undefined) {
      // The key is only ever placed on the wire; it is never logged.
      headers['authorization'] = `Bearer ${this.config.inferenceApiKey}`;
    }
    return headers;
  }

  private resolveModel(requested?: string): string | undefined {
    if (requested !== undefined && requested !== '') return requested;
    if (this.config.inferenceModel !== '') return this.config.inferenceModel;
    return undefined;
  }

  /**
   * Run a complete HTTP attempt (headers + response body consumption) under
   * one timeout. fetch() resolves when headers arrive, so timing only the
   * fetch call would leave JSON/SSE body reads able to hang indefinitely.
   */
  private async executeWithTimeout<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    toolName: string,
    traceId: string | undefined,
    execute: (response: Response) => Promise<T>,
    outerSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();

    const onOuterAbort = (): void => {
      controller.abort(outerSignal?.reason);
    };
    try {
      if (outerSignal?.aborted === true) {
        const reason = outerSignal.reason;
        throw reason instanceof Error ? reason : new Error('Request aborted by caller');
      }
      outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      return await execute(response);
    } catch (error) {
      if (timedOut) {
        throw new ToolTimeoutError(toolName, timeoutMs, errOpts(traceId));
      }
      throw error;
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
  }

  private async readErrorDetail(response: Response): Promise<string | undefined> {
    try {
      const text = await response.text();
      if (text.length === 0) return undefined;
      return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    } catch {
      return undefined;
    }
  }

  /**
   * Normalize a caught failure: returns a RetryableUpstreamError when the
   * failure may be retried, or undefined when it must propagate immediately.
   */
  private asRetryable(error: unknown, traceId: string | undefined): RetryableUpstreamError | undefined {
    if (error instanceof RetryableUpstreamError) return error;
    if (isNetworkError(error)) {
      return new RetryableUpstreamError(
        'inference',
        'Network error reaching inference endpoint',
        errOpts(traceId, error instanceof Error ? error.message : undefined),
      );
    }
    return undefined;
  }

  /**
   * Run one logical operation with retries, timeout, and metrics.
   * `execute` performs a single attempt against an already-fetched response.
   */
  private async runWithRetries<T>(
    toolName: string,
    url: string,
    init: RequestInit,
    timeoutMs: number,
    execute: (response: Response) => Promise<T>,
    options: RequestOptions,
  ): Promise<{ value: T; attempts: number; latencyMs: number }> {
    const { traceId, signal } = options;
    const log = traceId !== undefined ? this.logger.withTraceId(traceId) : this.logger;

    this.metrics.requestStarted();
    this.metrics.queueWaitStarted();
    try {
      await this.semaphore.acquire(signal);
    } catch (error) {
      this.metrics.queueWaitAborted();
      this.metrics.requestFinished(0, false);
      throw error;
    }
    this.metrics.queueWaitFinished();

    const startedAt = Date.now();
    try {
      let attempts = 0;
      for (;;) {
        attempts += 1;
        const attemptStartedAt = Date.now();
        try {
          const value = await this.executeWithTimeout(
            url,
            init,
            timeoutMs,
            toolName,
            traceId,
            async (response) => {
              if (response.status >= 500 || response.status === 429) {
                const detail = await this.readErrorDetail(response);
                throw new RetryableUpstreamError(
                  'inference',
                  `HTTP ${response.status} from inference endpoint`,
                  errOpts(traceId, detail),
                );
              }
              if (!response.ok) {
                const detail = await this.readErrorDetail(response);
                throw new ExternalServiceError(
                  'inference',
                  `HTTP ${response.status} from inference endpoint (not retryable)`,
                  errOpts(traceId, detail),
                );
              }
              return execute(response);
            },
            signal,
          );
          const latencyMs = Date.now() - attemptStartedAt;
          this.metrics.requestFinished(Date.now() - startedAt, true);
          log.debug({ toolName, attempts, latencyMs }, 'Inference request succeeded');
          return { value, attempts, latencyMs };
        } catch (error) {
          const retryable = this.asRetryable(error, traceId);
          if (retryable !== undefined && attempts <= this.config.inferenceMaxRetries) {
            this.metrics.retryIssued();
            const delay = backoffDelayMs(
              attempts - 1,
              this.config.inferenceRetryBaseDelayMs,
              this.config.inferenceRetryMaxDelayMs,
            );
            log.warn({ toolName, attempts, retryDelayMs: Math.round(delay) }, 'Retrying inference request');
            await this.sleepImpl(delay);
            if (signal?.aborted === true) {
              this.metrics.requestFinished(Date.now() - startedAt, false);
              const reason = signal.reason;
              throw reason instanceof Error ? reason : new Error('Request aborted while backing off');
            }
            continue;
          }
          this.metrics.requestFinished(Date.now() - startedAt, false);
          if (retryable !== undefined) {
            log.error({ toolName, attempts }, 'Inference request failed after retries');
            throw retryable;
          }
          throw error;
        }
      }
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Validate a public generation request. Zod failures are normalized to the
   * shared ValidationError so callers only handle contract error types.
   */
  private parseRequest(request: GenerationRequest, traceId: string | undefined): ParsedGenerationRequest {
    try {
      return generationRequestSchema.parse(request);
    } catch (error) {
      throw new ValidationError(
        'Invalid generation request: at least one message with a valid role and content is required.',
        errOpts(traceId, error instanceof Error ? error.message : undefined),
      );
    }
  }

  private completionBody(parsed: ParsedGenerationRequest): Record<string, unknown> {
    const model = this.resolveModel(parsed.model);
    const body: Record<string, unknown> = {
      messages: parsed.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: parsed.maxTokens ?? this.config.inferenceMaxOutputTokens,
    };
    if (model !== undefined) body['model'] = model;
    if (parsed.temperature !== undefined) body['temperature'] = parsed.temperature;
    if (parsed.topP !== undefined) body['top_p'] = parsed.topP;
    if (parsed.stop !== undefined) body['stop'] = parsed.stop;
    // Provider-specific Ollama extension: opt-in only; default stays compatible.
    if (this.config.inferenceThinkingMode === 'disabled') body['think'] = false;
    return body;
  }

  /** Non-streaming chat completion. */
  async complete(request: GenerationRequest, options: RequestOptions = {}): Promise<GenerationResult> {
    const parsed = this.parseRequest(request, options.traceId);
    enforceContextLimits(parsed, this.capabilities, { traceId: options.traceId });

    const body = this.completionBody(parsed);
    body['stream'] = false;

    const timeoutMs = options.timeoutMs ?? this.config.inferenceTimeoutMs;
    const { value, attempts, latencyMs } = await this.runWithRetries(
      'inference.complete',
      `${this.baseUrl()}/v1/chat/completions`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      timeoutMs,
      async (response) => {
        const json: unknown = await response.json();
        const parsedCompletion = chatCompletionResponseSchema.safeParse(json);
        if (!parsedCompletion.success) {
          throw new ValidationError(
            'Inference endpoint returned a malformed chat completion response.',
            errOpts(options.traceId, parsedCompletion.error.flatten()),
          );
        }
        const completion = parsedCompletion.data;
        const choice = completion.choices[0];
        if (choice === undefined) {
          throw new ExternalServiceError(
            'inference',
            'Inference endpoint returned no choices',
            errOpts(options.traceId),
          );
        }
        const promptTokens = completion.usage.prompt_tokens;
        const completionTokens = completion.usage.completion_tokens;
        return {
          content: choice.message.content ?? '',
          finishReason: choice.finish_reason,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: completion.usage.total_tokens ?? promptTokens + completionTokens,
          },
          model: completion.model,
        };
      },
      options,
    );

    this.metrics.tokensRecorded(value.usage.promptTokens, value.usage.completionTokens);
    const result: GenerationResult = { ...value, latencyMs, attempts };
    if (options.traceId !== undefined) result.traceId = options.traceId;
    return result;
  }

  /**
   * Streaming chat completion (SSE). `onDelta` is invoked for each content
   * chunk in order; the returned promise resolves to the full result.
   */
  async completeStream(
    request: GenerationRequest,
    onDelta: (delta: StreamDelta) => void | Promise<void>,
    options: RequestOptions = {},
  ): Promise<GenerationResult> {
    const parsed = this.parseRequest(request, options.traceId);
    enforceContextLimits(parsed, this.capabilities, { traceId: options.traceId });

    const body = this.completionBody(parsed);
    body['stream'] = true;
    body['stream_options'] = { include_usage: true };
    const requestedModel = this.resolveModel(parsed.model);

    const timeoutMs = options.timeoutMs ?? this.config.inferenceTimeoutMs;
    const { value, attempts, latencyMs } = await this.runWithRetries(
      'inference.completeStream',
      `${this.baseUrl()}/v1/chat/completions`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      timeoutMs,
      async (response) => {
        if (response.body === null) {
          throw new ExternalServiceError(
            'inference',
            'Streaming response had no body',
            errOpts(options.traceId),
          );
        }
        let content = '';
        let finishReason: string | null = null;
        let responseModel = requestedModel ?? 'unknown';
        let promptTokens = 0;
        let completionTokens = 0;
        let validChunkCount = 0;
        for await (const data of parseSseEvents(response.body)) {
          if (data === '[DONE]') break;
          let chunk: unknown;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue; // Skip malformed SSE payloads; the stream may still complete.
          }
          const parsedChunk = chatCompletionChunkSchema.safeParse(chunk);
          if (!parsedChunk.success) continue;
          validChunkCount += 1;
          const c = parsedChunk.data;
          if (c.model !== undefined) responseModel = c.model;
          const choice = c.choices?.[0];
          if (choice?.delta.content !== undefined) {
            content += choice.delta.content;
            await onDelta({
              content: choice.delta.content,
              finishReason: choice.finish_reason ?? null,
              model: responseModel,
            });
          }
          if (choice?.finish_reason != null) {
            finishReason = choice.finish_reason;
          }
          if (c.usage !== undefined) {
            promptTokens = c.usage.prompt_tokens;
            completionTokens = c.usage.completion_tokens;
          }
        }
        if (validChunkCount === 0) {
          throw new ValidationError(
            'Inference endpoint returned no valid SSE completion chunks.',
            errOpts(options.traceId),
          );
        }
        return {
          content,
          finishReason,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          },
          model: responseModel,
        };
      },
      options,
    );

    this.metrics.tokensRecorded(value.usage.promptTokens, value.usage.completionTokens);
    const result: GenerationResult = { ...value, latencyMs, attempts };
    if (options.traceId !== undefined) result.traceId = options.traceId;
    return result;
  }

  /** List models from GET /v1/models. Used by health checks and capabilities. */
  async getModels(options: RequestOptions = {}): Promise<ModelInfo[]> {
    const timeoutMs = options.timeoutMs ?? this.config.inferenceHealthTimeoutMs;
    const { value } = await this.runWithRetries(
      'inference.getModels',
      `${this.baseUrl()}/v1/models`,
      { method: 'GET', headers: this.headers() },
      timeoutMs,
      async (response) => {
        const json: unknown = await response.json();
        const parsedModels = modelsResponseSchema.safeParse(json);
        if (!parsedModels.success) {
          throw new ValidationError(
            'Inference endpoint returned a malformed model list.',
            errOpts(options.traceId, parsedModels.error.flatten()),
          );
        }
        return parsedModels.data.data.map(toModelInfo);
      },
      options,
    );
    return value;
  }
}
