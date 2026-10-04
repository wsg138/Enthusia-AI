/**
 * @enthusia/integration-databases — read-only connection management (W10).
 *
 * Spec: MASTER-SPECIFICATION.md §5.5, §16.1, §25.3, §34.1.
 *
 * The manager is the only path from a tool to a driver:
 * 1. resolves the template by registry key (never SQL text);
 * 2. rejects non-scalar params (objects/arrays/functions can expand into SQL
 *    in some drivers — they never reach one here);
 * 3. verifies param count matches the template's placeholder count;
 * 4. enforces the per-query timeout (aborts the driver call, reports
 *    DB_TIMEOUT);
 * 5. re-enforces the row cap even if a driver ignored it;
 * 6. scrubs every error so credentials can never appear in tool output.
 */
import type { DatabaseConfig } from './config.js';
import { getQueryTemplate } from './query-templates.js';
import type { QueryTemplateName } from './query-templates.js';
import type {
  DbClientFactory,
  DbRow,
  ExecutedQuery,
  QueryOptions,
  ReadOnlyDbClient,
} from './client.js';
import { DbClientError, defaultDbClientFactory } from './client.js';

export interface TemplateCallOptions {
  timeoutMs?: number;
  maxRows?: number;
  signal?: AbortSignal;
}

/** Machine-readable manager failure. `detail` never carries credentials. */
export class DbManagerError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'DbManagerError';
    this.code = code;
    this.retryable = retryable;
  }
}

function isScalarParam(value: unknown): boolean {
  const t = typeof value;
  return value === null || t === 'string' || t === 'number' || t === 'boolean';
}

function assertScalarParams(
  templateName: QueryTemplateName,
  paramCount: number,
  params: readonly unknown[],
): void {
  if (params.length !== paramCount) {
    throw new DbManagerError(
      'INVALID_QUERY_PARAMS',
      `template ${templateName}: expected ${paramCount} params, got ${params.length}`,
      false,
    );
  }
  for (const [index, param] of params.entries()) {
    if (!isScalarParam(param)) {
      throw new DbManagerError(
        'INVALID_QUERY_PARAMS',
        `template ${templateName}: param ${index} must be a scalar (string/number/boolean/null)`,
        false,
      );
    }
  }
}

/**
 * Remove anything credential-shaped from an error message before it can
 * reach a tool result. Defense in depth: the config password is never
 * interpolated into messages in the first place.
 */
function scrubErrorMessage(message: string): string {
  return message
    .replace(/password\s*[=:]\s*\S+/gi, 'password=[redacted]')
    .replace(/:[^:@/\s]+@/g, ':[redacted]@')
    .slice(0, 500);
}

function combineSignals(
  signals: Array<AbortSignal | undefined>,
): { signal: AbortSignal; abort: () => void; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  const active = signals.filter((s): s is AbortSignal => s !== undefined);
  for (const s of active) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => {
      for (const s of active) s.removeEventListener('abort', onAbort);
    },
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(
        new DbManagerError(
          'DB_TIMEOUT',
          `database query exceeded ${timeoutMs}ms`,
          true,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Owns the read-only client lifecycle and enforces timeouts, row caps, and
 * param safety for every template execution. Lazily connects on first use.
 */
export class DatabaseConnectionManager {
  private clientPromise: Promise<ReadOnlyDbClient> | null = null;
  private closed = false;

  constructor(
    private readonly config: DatabaseConfig,
    private readonly factory: DbClientFactory = defaultDbClientFactory,
  ) {
    // The zod schema already pins readOnly to `true`; this is a second,
    // explicit gate so a hand-built config object can never slip through.
    if ((config as { readOnly?: unknown }).readOnly !== true) {
      throw new DbManagerError(
        'INVALID_DB_CONFIG',
        'database tools require a read-only connection (readOnly: true)',
        false,
      );
    }
  }

  /** Execute one registered template with bound scalar params. */
  async executeTemplate(
    name: QueryTemplateName,
    params: readonly unknown[],
    callOptions: TemplateCallOptions = {},
  ): Promise<ExecutedQuery> {
    if (this.closed) {
      throw new DbManagerError('DB_CLIENT_CLOSED', 'connection manager is closed', false);
    }
    const template = getQueryTemplate(name);
    assertScalarParams(name, template.paramCount, params);

    const requestedTimeout = callOptions.timeoutMs ?? this.config.queryTimeoutMs;
    const requestedMaxRows = callOptions.maxRows ?? this.config.maxRows;
    if (!Number.isInteger(requestedTimeout) || requestedTimeout <= 0) {
      throw new DbManagerError('INVALID_QUERY_LIMITS', 'timeoutMs must be a positive integer', false);
    }
    if (!Number.isInteger(requestedMaxRows) || requestedMaxRows <= 0) {
      throw new DbManagerError('INVALID_QUERY_LIMITS', 'maxRows must be a positive integer', false);
    }
    // Callers may tighten safety limits, never widen deployment policy.
    const timeoutMs = Math.min(requestedTimeout, this.config.queryTimeoutMs);
    const maxRows = Math.min(requestedMaxRows, this.config.maxRows);
    const combined = combineSignals([callOptions.signal]);

    try {
      const client = await this.getClient();
      const options: QueryOptions = {
        timeoutMs,
        maxRows,
        signal: combined.signal,
      };
      const executed = await withTimeout(
        client.query(template.sql, params, options),
        timeoutMs,
        () => combined.abort(),
      );
      // Re-enforce the row cap even if a driver ignored it.
      if (executed.rows.length > maxRows) {
        const rows: DbRow[] = executed.rows.slice(0, maxRows);
        return { ...executed, rows, truncated: true };
      }
      return executed;
    } catch (error) {
      throw normalizeError(error);
    } finally {
      combined.dispose();
    }
  }

  /** Release the underlying client. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.clientPromise !== null) {
      const client = await this.clientPromise.catch(() => undefined);
      await client?.close().catch(() => undefined);
      this.clientPromise = null;
    }
  }

  private getClient(): Promise<ReadOnlyDbClient> {
    if (this.clientPromise === null) {
      this.clientPromise = this.factory(this.config).catch((error: unknown) => {
        this.clientPromise = null;
        throw normalizeError(error);
      });
    }
    return this.clientPromise;
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof DbManagerError) return error;
  if (error instanceof DbClientError) {
    return new DbManagerError(
      error.code,
      scrubErrorMessage(error.message),
      error.retryable,
    );
  }
  const message =
    error instanceof Error ? error.message : 'unknown database failure';
  return new DbManagerError('DB_QUERY_FAILED', scrubErrorMessage(message), false);
}
