/**
 * @enthusia/integration-databases — read-only database connection configuration (W10).
 *
 * Spec: MASTER-SPECIFICATION.md §§5.5 (tools hold credentials; models do not),
 * §16.1 (database: read-only purpose-built queries), §25.3 (read-only
 * credentials), §34.1 (secret handling).
 *
 * Credentials come from the environment (or another protected config source)
 * and are held only inside the tool layer. They are NEVER included in tool
 * output, logs, provenance, or error messages — see `describeConfigForLog`
 * and the scrubbing in connection.ts.
 */
import { z } from 'zod';

export const databaseConfigSchema = z.object({
  host: z.string().min(1, 'ENTHUSIA_DB_HOST is required'),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1, 'ENTHUSIA_DB_NAME is required'),
  username: z.string().min(1, 'ENTHUSIA_DB_USER is required'),
  /** May be empty when socket/peer auth is used. NEVER logged or returned. */
  password: z.string(),
  /** Per-query wall-clock budget in milliseconds. */
  queryTimeoutMs: z.number().int().min(100).max(60_000),
  /** Hard cap on rows handed to the model per tool call. */
  maxRows: z.number().int().min(1).max(100),
  /**
   * Read-only invariant. The literal type makes it impossible to construct a
   * read/write config for this integration — deployments must use a separate
   * read-only database account (§25.3).
   */
  readOnly: z.literal(true),
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

export const DEFAULT_QUERY_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_ROWS = 25;
export const DEFAULT_PORT = 3306;

/** Machine-readable configuration failure. Carries no credential material. */
export class DatabaseConfigError extends Error {
  readonly code = 'INVALID_DB_CONFIG';
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

function optionalNumberEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Build a DatabaseConfig from environment variables. The schema validates
 * ranges; out-of-range values are rejected rather than silently clamped.
 *
 * Recognized variables:
 * - ENTHUSIA_DB_HOST (required)
 * - ENTHUSIA_DB_PORT (default 3306)
 * - ENTHUSIA_DB_NAME (required)
 * - ENTHUSIA_DB_USER (required)
 * - ENTHUSIA_DB_PASSWORD (default '')
 * - ENTHUSIA_DB_QUERY_TIMEOUT_MS (default 5000)
 * - ENTHUSIA_DB_MAX_ROWS (default 25)
 */
export function loadDatabaseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const parsed = databaseConfigSchema.safeParse({
    host: env['ENTHUSIA_DB_HOST'],
    port: optionalNumberEnv(env, 'ENTHUSIA_DB_PORT', DEFAULT_PORT),
    database: env['ENTHUSIA_DB_NAME'],
    username: env['ENTHUSIA_DB_USER'],
    password: env['ENTHUSIA_DB_PASSWORD'] ?? '',
    queryTimeoutMs: optionalNumberEnv(
      env,
      'ENTHUSIA_DB_QUERY_TIMEOUT_MS',
      DEFAULT_QUERY_TIMEOUT_MS,
    ),
    maxRows: optionalNumberEnv(env, 'ENTHUSIA_DB_MAX_ROWS', DEFAULT_MAX_ROWS),
    readOnly: true,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new DatabaseConfigError(`invalid database configuration: ${detail}`);
  }
  return parsed.data;
}

/**
 * Diagnostics-safe view of the config. The password key is absent entirely
 * (not merely masked) so it cannot leak through serialization.
 */
export function describeConfigForLog(
  config: DatabaseConfig,
): Record<string, string | number | boolean> {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    queryTimeoutMs: config.queryTimeoutMs,
    maxRows: config.maxRows,
    readOnly: config.readOnly,
  };
}
