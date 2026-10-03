/**
 * Common typed errors shared across all Enthusia AI services.
 *
 * Every error carries:
 * - a stable machine-readable `code`;
 * - an HTTP-style `statusCode` for API boundaries;
 * - a `visibilitySafe` message safe to surface to the caller;
 * - an optional `traceId` for correlation.
 *
 * Internal detail that must not leak across visibility boundaries goes in
 * `detail` and must never be rendered to a lower-visibility surface.
 */

export interface EnthusiaErrorOptions {
  traceId?: string;
  /** Internal-only detail. Never surfaced below SYSTEM_INTERNAL. */
  detail?: unknown;
  cause?: unknown;
}

export class EnthusiaError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly traceId: string | undefined;
  readonly detail: unknown;

  constructor(code: string, statusCode: number, message: string, options: EnthusiaErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.traceId = options.traceId;
    this.detail = options.detail;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      statusCode: this.statusCode,
      message: this.message,
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
    };
  }
}

/** Request payload failed validation (400). */
export class ValidationError extends EnthusiaError {
  constructor(message: string, options: EnthusiaErrorOptions = {}) {
    super('VALIDATION_ERROR', 400, message, options);
  }
}

/** Caller lacks permission for the operation (403). */
export class AuthorizationError extends EnthusiaError {
  constructor(message: string, options: EnthusiaErrorOptions = {}) {
    super('AUTHORIZATION_ERROR', 403, message, options);
  }
}

/** Requested resource does not exist (404). */
export class NotFoundError extends EnthusiaError {
  constructor(message: string, options: EnthusiaErrorOptions = {}) {
    super('NOT_FOUND', 404, message, options);
  }
}

/** A tool call exceeded its deadline (504). Retryable by default. */
export class ToolTimeoutError extends EnthusiaError {
  constructor(toolName: string, timeoutMs: number, options: EnthusiaErrorOptions = {}) {
    super('TOOL_TIMEOUT', 504, `Tool '${toolName}' timed out after ${timeoutMs}ms`, options);
  }
}

/** Visibility policy denied disclosure (403). Message is always generic. */
export class VisibilityDeniedError extends EnthusiaError {
  constructor(options: EnthusiaErrorOptions = {}) {
    super(
      'VISIBILITY_DENIED',
      403,
      'The requested information cannot be disclosed under the current visibility ceiling.',
      options,
    );
  }
}

/** A source/version can no longer be proven current (410). */
export class StaleSourceError extends EnthusiaError {
  constructor(sourceLocator: string, options: EnthusiaErrorOptions = {}) {
    super('STALE_SOURCE', 410, `Source '${sourceLocator}' can no longer be proven current.`, options);
  }
}

/** Conflicting writes / optimistic-concurrency failure (409). */
export class ConflictError extends EnthusiaError {
  constructor(message: string, options: EnthusiaErrorOptions = {}) {
    super('CONFLICT', 409, message, options);
  }
}

/** Rate limit exceeded (429). */
export class RateLimitError extends EnthusiaError {
  /** Seconds the caller should wait before retrying, when known. */
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, retryAfterSeconds?: number, options: EnthusiaErrorOptions = {}) {
    super('RATE_LIMITED', 429, message, options);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A downstream external service failed (502). */
export class ExternalServiceError extends EnthusiaError {
  /** Identity of the failing external service. */
  readonly service: string;

  constructor(service: string, message: string, options: EnthusiaErrorOptions = {}) {
    super('EXTERNAL_SERVICE_ERROR', 502, `External service '${service}' failed: ${message}`, options);
    this.service = service;
  }
}
