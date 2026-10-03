import { z } from 'zod';

/**
 * @enthusia/config — environment-based configuration with Zod validation.
 *
 * Spec: MASTER-SPECIFICATION.md §9.1 ("Zod or equivalent for configuration
 * and payload validation") and §77 (production configuration).
 *
 * Rules:
 * - All configuration comes from environment variables with sensible defaults.
 * - NO secrets in code and NO secrets in .env.example — secret values are
 *   provided at deploy time only and are always optional here so tests and
 *   local dev run without production credentials (§75/§76).
 */

const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const nodeEnvSchema = z.enum(['development', 'test', 'production']);

const portSchema = z.coerce.number().int().min(1).max(65535);

export const appConfigSchema = z.object({
  nodeEnv: nodeEnvSchema.default('development'),
  serviceName: z.string().min(1).default('enthusia-ai'),
  serviceVersion: z.string().min(1).default('0.1.0'),
  logLevel: logLevelSchema.default('info'),

  /** AI gateway HTTP port. */
  aiGatewayPort: portSchema.default(4100),
  /** Discord bot shard count; 1 = no sharding. */
  discordShardCount: z.coerce.number().int().min(1).default(1),

  /** Model artifact directory (local inference runtime, swappable per §9.2). */
  modelDir: z.string().min(1).default('./models'),
  /** Max inference concurrency; bound per §9.2. */
  inferenceConcurrency: z.coerce.number().int().min(1).default(2),

  /** Tool call default timeout (ms). */
  toolDefaultTimeoutMs: z.coerce.number().int().positive().default(30_000),
  /** Max tool calls per agent turn (tool budget, §78). */
  maxToolCallsPerTurn: z.coerce.number().int().positive().default(10),

  // --- Optional integrations (all optional; never required for tests) ---
  /** Postgres connection string. OPTIONAL — provided at deploy time, never committed. */
  databaseUrl: z.string().min(1).optional(),
  /** Vector index (Qdrant) URL. OPTIONAL. */
  vectorIndexUrl: z.string().url().optional(),
  /** Discord bot token. OPTIONAL — placeholder in .env.example only. */
  discordBotToken: z.string().min(1).optional(),
  /** OpenAI API key for strong-model escalation. OPTIONAL. */
  openaiApiKey: z.string().min(1).optional(),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

/** Field names that must never appear in logs or error output. */
const SECRET_FIELDS = new Set(['databaseUrl', 'discordBotToken', 'openaiApiKey']);

/** Load and validate configuration from `env` (defaults to process.env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return appConfigSchema.parse({
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
}

/**
 * Redacted view of the config for logs/startup banners.
 * Secret fields are replaced with '<set>' / '<unset>' — values never logged.
 */
export function redactedConfig(config: AppConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_FIELDS.has(key)) {
      out[key] = value === undefined || value === '' ? '<unset>' : '<set>';
    } else {
      out[key] = value;
    }
  }
  return out;
}
