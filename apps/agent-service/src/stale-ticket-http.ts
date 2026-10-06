import type http from 'node:http';
import {
  TRACE_ID_HEADER,
  newTraceId,
} from '@enthusia/contracts';
import {
  staleTicketDecisionRequestSchema,
  type StaleTicketDecisionService,
} from './stale-ticket.js';

export interface StaleTicketHttpDeps {
  maxBodyBytes: number;
  service?: Pick<StaleTicketDecisionService, 'decide'>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  traceId?: string,
): void {
  res.writeHead(statusCode, {
    ...JSON_HEADERS,
    ...(traceId !== undefined ? { [TRACE_ID_HEADER]: traceId } : {}),
  });
  res.end(JSON.stringify(body));
}

function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

async function parseBody(
  req: http.IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  let raw: Buffer;
  try {
    raw = await readBody(req, maxBodyBytes);
  } catch {
    throw new StaleTicketHttpError(
      413,
      'REQUEST_TOO_LARGE',
      'request body exceeds limit',
    );
  }

  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new StaleTicketHttpError(
      400,
      'INVALID_JSON',
      'request body is not valid JSON',
    );
  }
}

class StaleTicketHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sendKnownError(
  res: http.ServerResponse,
  error: StaleTicketHttpError,
): void {
  sendJson(res, error.status, {
    error: { code: error.code, message: error.message },
  });
}

export async function handleStaleTicketDecisionHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: StaleTicketHttpDeps,
): Promise<void> {
  if (deps.service === undefined) {
    sendJson(res, 503, {
      error: {
        code: 'STALE_TICKET_DECISION_UNAVAILABLE',
        message: 'stale ticket decision service is unavailable',
      },
    });
    return;
  }

  let value: unknown;
  try {
    value = await parseBody(req, deps.maxBodyBytes);
  } catch (error) {
    if (error instanceof StaleTicketHttpError) {
      sendKnownError(res, error);
      return;
    }
    throw error;
  }

  const parsed = staleTicketDecisionRequestSchema.safeParse(value);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: {
        code: 'INVALID_STALE_TICKET_REQUEST',
        message: 'request does not match stale ticket decision contract',
      },
    });
    return;
  }

  const traceId = newTraceId();
  try {
    const decision = await deps.service.decide(parsed.data, traceId);
    sendJson(res, 200, decision, traceId);
  } catch {
    sendJson(
      res,
      503,
      {
        error: {
          code: 'STALE_TICKET_DECISION_FAILED',
          message: 'stale ticket decision could not be completed',
        },
      },
      traceId,
    );
  }
}
