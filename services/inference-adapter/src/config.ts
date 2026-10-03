import { z } from 'zod';
import { appConfigSchema, type AppConfig } from '@enthusia/config';

/**
 * @enthusia/inference-adapter — configuration.
 *
 * Spec: MASTER-SPECIFICATION.md §9.2 (inference runtime must be swappable,
 * bounded memory/concurrency/timeouts) and §77 (production configuration).
 *
 * All values come from the environment with safe defaults. The inference API
 * key is optional only in development/test; production fails closed without
 * it. The key is NEVER logged — use redactedInferenceConfig() for any logged
 * or surfaced view.
 */
export const inferenceConfigSchema = appConfigSchema.extend({
  /**
   * Base URL of the OpenAI-compatible inference endpoint.
   * Default is the llama.cpp server default port; any OpenAI-compatible
   * server (vLLM, text-generation-webui with OpenAI extension, etc.) works.
   */
  inferenceBaseUrl: z.string().url().default('http://localhost:8080'),

  /**
   * Model identifier sent as `model` in chat completion requests.
   * Empty string omits the field and lets the server use its loaded default.
   */
  inferenceModel: z.string().default(''),

  /**
   * Optional API key for the inference endpoint (llama.cpp --api-key).
   * Sent as a Bearer token. OPTIONAL — local dev runs without one.
   */
  inferenceApiKey: z.string().min(1).optional(),

  /**
   * Per-attempt generation timeout in milliseconds.
   * Every request is bounded; default 120s per W03 requirements.
   */
  inferenceTimeoutMs: z.coerce.number().int().positive().default(120_000),

  /**
   * Maximum retries on retryable failures (HTTP 5xx, 429, network errors).
   * Total attempts per request = 1 + inferenceMaxRetries.
   */
  inferenceMaxRetries: z.coerce.number().int().min(0).default(3),

  /** Base delay for exponential backoff between retries (ms). */
  inferenceRetryBaseDelayMs: z.coerce.number().int().min(0).default(500),

  /** Upper bound for the backoff delay between retries (ms). */
  inferenceRetryMaxDelayMs: z.coerce.number().int().positive().default(10_000),

  /**
   * Context window size in tokens used for context-limit enforcement.
   * Spec §10.4: start around 16K–32K; increase only with evaluation evidence.
   */
  inferenceMaxContextTokens: z.coerce.number().int().positive().default(32_768),

  /** Maximum tokens generated per request (budget guard). */
  inferenceMaxOutputTokens: z.coerce.number().int().positive().default(4_096),

  /** Timeout for health-check probes in milliseconds. */
  inferenceHealthTimeoutMs: z.coerce.number().int().positive().default(5_000),
});

export type InferenceConfig = z.infer<typeof inferenceConfigSchema>;

/** Field names that must never appear in logs or error output. */
const INFERENCE_SECRET_FIELDS = new Set(['inferenceApiKey']);

/** Load and validate the inference configuration from `env` (defaults to process.env). */
export function loadInferenceConfig(env: NodeJS.ProcessEnv = process.env): InferenceConfig {
  const base: AppConfig = appConfigSchema.parse({
    nodeEnv: env['NODE_ENV'],
    serviceName: env['ENTHUSIA_SERVICE_NAME'],
    serviceVersion: env['ENTHUSIA_SERVICE_VERSION'],
    logLevel: env['ENTHUSIA_LOG_LEVEL'],
    aiGatewayPort: env['ENTHUSIA_AI_GATEWAY_PORT'],
    discordShardCount: env['ENTHUSIA_DISCORD_SHARD_COUNT'],
    modelDir: env['ENTHUSIA_MODEL_DIR'],
    inferenceConcurrency: env['ENTHUSIA_INFERENCE_CONCURRENCY'],
    toolDefaultTimeoutMs: env['ENTHUSIA_TOOL_DEFAULT_TIMEOUT_MS'],
    maxToolCallsPerTurn: env['ENTHUSIA_MAX_TOOL_CALLS_PER_TURN'],
    databaseUrl: env['ENTHUSIA_DATABASE_URL'],
    vectorIndexUrl: env['ENTHUSIA_VECTOR_INDEX_URL'],
    discordBotToken: env['DISCORD_BOT_TOKEN'],
    openaiApiKey: env['OPENAI_API_KEY'],
  });

  const config = inferenceConfigSchema.parse({
    ...base,
    inferenceBaseUrl: env['ENTHUSIA_INFERENCE_BASE_URL'],
    inferenceModel: env['ENTHUSIA_INFERENCE_MODEL'],
    inferenceApiKey: env['ENTHUSIA_INFERENCE_API_KEY'],
    inferenceTimeoutMs: env['ENTHUSIA_INFERENCE_TIMEOUT_MS'],
    inferenceMaxRetries: env['ENTHUSIA_INFERENCE_MAX_RETRIES'],
    inferenceRetryBaseDelayMs: env['ENTHUSIA_INFERENCE_RETRY_BASE_DELAY_MS'],
    inferenceRetryMaxDelayMs: env['ENTHUSIA_INFERENCE_RETRY_MAX_DELAY_MS'],
    inferenceMaxContextTokens: env['ENTHUSIA_INFERENCE_MAX_CONTEXT_TOKENS'],
    inferenceMaxOutputTokens: env['ENTHUSIA_INFERENCE_MAX_OUTPUT_TOKENS'],
    inferenceHealthTimeoutMs: env['ENTHUSIA_INFERENCE_HEALTH_TIMEOUT_MS'],
  });
  if (config.nodeEnv === 'production' && config.inferenceApiKey === undefined) {
    throw new Error(
      'ENTHUSIA_INFERENCE_API_KEY is required when NODE_ENV=production.',
    );
  }
  return config;
}

/**
 * Redacted view of the inference config for logs/startup banners.
 * Secret fields are replaced with '<set>' / '<unset>' — values never logged.
 */
export function redactedInferenceConfig(config: InferenceConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (INFERENCE_SECRET_FIELDS.has(key)) {
      out[key] = value === undefined || value === '' ? '<unset>' : '<set>';
    } else {
      out[key] = value;
    }
  }
  return out;
}
