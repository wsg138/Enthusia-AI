/**
 * @enthusia/integration-databases — read-only database client port (W10).
 *
 * Spec: MASTER-SPECIFICATION.md §16.1, §25.2 (purpose-built read tools, never
 * arbitrary model SQL), §25.3 (read-only credentials).
 *
 * `ReadOnlyDbClient` is a narrow port: one `query` method that executes
 * template SQL with bound params, plus `close`. Production deployments inject
 * a driver-backed factory (e.g. mysql2/promise configured with a read-only
 * account). This package bundles NO driver and makes NO real connections —
 * `defaultDbClientFactory` fails closed so a misconfigured deployment can
 * never silently fall back to something unsafe.
 *
 * Tests use `MockReadOnlyDbClient`, which scripts per-template rows, records
 * every executed statement (so tests can prove the SQL text never changes),
 * honors abort signals, and enforces row caps.
 */
import type { DatabaseConfig } from './config.js';
import { getQueryTemplate } from './query-templates.js';
import type { QueryTemplateName } from './query-templates.js';

/** One result row: column name -> value. Values stay opaque to this layer. */
export type DbRow = Record<string, unknown>;

export interface QueryOptions {
  /** Wall-clock budget for this query in milliseconds. */
  timeoutMs: number;
  /** Maximum rows to hand back; excess rows are dropped and flagged. */
  maxRows: number;
  /** Optional caller abort signal (tool timeout, request cancellation). */
  signal?: AbortSignal;
}

export interface ExecutedQuery {
  /** Byte-identical template SQL that was executed. */
  readonly sql: string;
  /** Bound parameter values — the only model-influenced part of the call. */
  readonly params: readonly unknown[];
  readonly rows: DbRow[];
  /** True when rows were dropped to respect maxRows. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface ReadOnlyDbClient {
  /** Human-readable driver label for provenance (e.g. 'mysql2/promise'). */
  readonly label: string;
  query(
    sql: string,
    params: readonly unknown[],
    options: QueryOptions,
  ): Promise<ExecutedQuery>;
  close(): Promise<void>;
}

/**
 * Builds the live client for a deployment. Injected — never constructed from
 * model input.
 */
export type DbClientFactory = (
  config: DatabaseConfig,
) => Promise<ReadOnlyDbClient>;

/** Machine-readable client/driver failure. */
export class DbClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'DbClientError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Default factory: fails closed. There is no bundled driver on purpose —
 * shipping a default that "just connects" would risk connecting with the
 * wrong privileges. Deployments MUST inject a factory backed by a read-only
 * account (see README.md).
 */
export const defaultDbClientFactory: DbClientFactory = async () => {
  throw new DbClientError(
    'DB_DRIVER_NOT_CONFIGURED',
    'no database driver configured: inject a DbClientFactory backed by a read-only account',
    false,
  );
};

export interface MockScript {
  /** Rows to return, or a function computing them from the bound params. */
  rows?: DbRow[] | ((params: readonly unknown[]) => DbRow[]);
  /** Simulated latency before rows resolve. */
  latencyMs?: number;
  /** When set, the query fails with this error instead of returning rows. */
  error?: { code: string; message: string; retryable: boolean };
}

export interface MockCall {
  readonly template: QueryTemplateName;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly options: QueryOptions;
}

/**
 * In-memory fake client for unit tests. NO network, NO production data.
 * Keyed by template name so tests script exactly the queries the tools use.
 */
export class MockReadOnlyDbClient implements ReadOnlyDbClient {
  readonly label = 'mock';
  readonly calls: MockCall[] = [];
  private closed = false;

  constructor(
    private readonly scripts: Partial<Record<QueryTemplateName, MockScript>>,
  ) {}

  async query(
    sql: string,
    params: readonly unknown[],
    options: QueryOptions,
  ): Promise<ExecutedQuery> {
    if (this.closed) {
      throw new DbClientError('DB_CLIENT_CLOSED', 'mock client is closed', false);
    }
    const startedAt = Date.now();
    const template = templateNameForSql(sql);
    this.calls.push({ template, sql, params, options });

    const script = this.scripts[template];
    if (script === undefined) {
      throw new DbClientError(
        'NO_MOCK_SCRIPT',
        `no mock script for template ${template} (fail closed)`,
        false,
      );
    }
    if (script.error !== undefined) {
      await sleepInterruptible(script.latencyMs ?? 0, options.signal);
      throw new DbClientError(
        script.error.code,
        script.error.message,
        script.error.retryable,
      );
    }
    await sleepInterruptible(script.latencyMs ?? 0, options.signal);
    const allRows =
      typeof script.rows === 'function' ? script.rows(params) : (script.rows ?? []);
    const truncated = allRows.length > options.maxRows;
    return {
      sql,
      params,
      rows: truncated ? allRows.slice(0, options.maxRows) : [...allRows],
      truncated,
      durationMs: Date.now() - startedAt,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Reverse lookup: which registered template does this SQL text belong to? */
function templateNameForSql(sql: string): QueryTemplateName {
  // Compare against every template; identity must be exact.
  const names: QueryTemplateName[] = [
    'linkedAccount',
    'playerRank',
    'permissionState',
    'ticketMetadata',
    'economyFact',
  ];
  for (const name of names) {
    if (getQueryTemplate(name).sql === sql) return name;
  }
  throw new DbClientError(
    'UNKNOWN_TEMPLATE_SQL',
    'mock client received SQL that matches no registered template',
    false,
  );
}

function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted === true) {
      return Promise.reject(
        new DbClientError('DB_ABORTED', 'query aborted', false),
      );
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new DbClientError('DB_ABORTED', 'query aborted', false));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
