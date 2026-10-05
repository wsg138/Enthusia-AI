import {
  SecretDenyError,
} from './deny.js';
import {
  SftpPathEscapeError,
} from './sftp-client.js';
import type {
  LiveServerIdentity,
  LiveSourceErrorCode,
  LiveSourceResult,
} from './live-types.js';

const SAFE_MESSAGES: Record<LiveSourceErrorCode, string> = {
  UNKNOWN_SERVER: 'server source is not configured',
  SOURCE_NOT_CONFIGURED: 'requested source is not configured for this server',
  INVALID_REQUEST: 'request did not match the typed source contract',
  PATH_DENIED: 'source path was denied by the read-only boundary',
  OVERSIZE: 'source exceeds the configured read limit',
  TIMEOUT: 'server source operation timed out',
  ABORTED: 'server source operation was cancelled',
  UNREACHABLE: 'server source is unreachable',
  SOURCE_UNAVAILABLE: 'server source operation failed safely',
  SECRET_CONTENT_DENIED: 'source content was denied by the secret boundary',
  UNSUPPORTED_CONTENT: 'source content is not safe text',
};

export class LiveBoundaryError extends Error {
  constructor(
    readonly code: LiveSourceErrorCode,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'LiveBoundaryError';
  }
}

export class LiveTimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'LiveTimeoutError';
  }
}

export class LiveAbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'LiveAbortError';
  }
}

export function fail<T>(
  server: LiveServerIdentity,
  observedAt: string,
  code: LiveSourceErrorCode,
  retryable: boolean,
): LiveSourceResult<T> {
  return {
    ok: false,
    server,
    observedAt,
    error: {
      code,
      message: SAFE_MESSAGES[code],
      retryable,
    },
  };
}

export function mapLiveFailure<T>(
  server: LiveServerIdentity,
  observedAt: string,
  error: unknown,
  connecting: boolean,
): LiveSourceResult<T> {
  if (error instanceof LiveTimeoutError) return fail(server, observedAt, 'TIMEOUT', true);
  if (error instanceof LiveAbortError) return fail(server, observedAt, 'ABORTED', false);
  if (error instanceof SecretDenyError || error instanceof SftpPathEscapeError) {
    return fail(server, observedAt, 'PATH_DENIED', false);
  }
  if (error instanceof LiveBoundaryError) {
    return fail(server, observedAt, error.code, error.retryable);
  }
  return fail(
    server,
    observedAt,
    connecting ? 'UNREACHABLE' : 'SOURCE_UNAVAILABLE',
    true,
  );
}
