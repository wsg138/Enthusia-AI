import pino, { type LoggerOptions, type Logger as PinoLogger } from 'pino';

/**
 * @enthusia/logging — structured JSON logging with trace ID support.
 *
 * Thin wrapper over pino. Every service creates one root logger and derives
 * per-request child loggers carrying the trace ID (§36 structured logs,
 * request IDs).
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface CreateLoggerOptions {
  /** Service/component name included in every line. */
  name: string;
  level?: LogLevel;
  /** Base fields merged into every log line. */
  base?: Record<string, unknown>;
  /** Override the output stream (tests). Defaults to process.stdout. */
  stream?: NodeJS.WritableStream;
}

type LogFn = {
  (msg: string): void;
  (obj: Record<string, unknown>, msg: string): void;
};

export interface EnthusiaLogger {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  /** Derive a child logger that always includes the trace ID. */
  withTraceId(traceId: string): EnthusiaLogger;
  /** Derive a child logger with extra bound fields. */
  child(bindings: Record<string, unknown>): EnthusiaLogger;
}

function asLogFn(fn: (obj: unknown, msg?: string) => void): LogFn {
  return ((obj: unknown, msg?: string) => {
    if (msg === undefined) {
      fn(obj as string);
    } else {
      fn(obj as Record<string, unknown>, msg);
    }
  }) as LogFn;
}

function wrap(inner: PinoLogger): EnthusiaLogger {
  return {
    trace: asLogFn(inner.trace.bind(inner)),
    debug: asLogFn(inner.debug.bind(inner)),
    info: asLogFn(inner.info.bind(inner)),
    warn: asLogFn(inner.warn.bind(inner)),
    error: asLogFn(inner.error.bind(inner)),
    fatal: asLogFn(inner.fatal.bind(inner)),
    withTraceId: (traceId: string) => wrap(inner.child({ traceId })),
    child: (bindings: Record<string, unknown>) => wrap(inner.child(bindings)),
  };
}

export function createLogger(options: CreateLoggerOptions): EnthusiaLogger {
  const pinoOptions: LoggerOptions = {
    name: options.name,
    level: options.level ?? 'info',
    // Keep timestamps as ISO strings for human/machine readability.
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(options.base !== undefined ? { base: options.base } : {}),
  };
  const inner = options.stream ? pino(pinoOptions, options.stream) : pino(pinoOptions);
  return wrap(inner);
}
