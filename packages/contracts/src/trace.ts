import { randomUUID } from 'node:crypto';

/**
 * Trace ID conventions.
 *
 * - Trace IDs are UUID v4 strings.
 * - Generated once per inbound request (W02 ai-gateway) and propagated
 *   through every service, tool call, and log line for that request.
 * - Propagated over HTTP via the `x-enthusia-trace-id` header and through
 *   in-process calls via explicit context parameters / AsyncLocalStorage.
 */

/** HTTP header used to propagate the trace ID between services. */
export const TRACE_ID_HEADER = 'x-enthusia-trace-id';

/** Generate a new UUID v4 trace ID. */
export function newTraceId(): string {
  return randomUUID();
}

/** True when `value` is a syntactically valid UUID (any version). */
export function isValidTraceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Extract a trace ID from inbound HTTP headers.
 * Returns the caller-supplied ID when valid, otherwise a fresh one.
 */
export function extractTraceId(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers[TRACE_ID_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate === 'string' && isValidTraceId(candidate)) {
    return candidate;
  }
  return newTraceId();
}
