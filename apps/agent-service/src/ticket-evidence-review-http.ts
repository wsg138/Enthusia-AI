import type http from 'node:http';
import {
  TRACE_ID_HEADER,
  extractTraceId,
} from '@enthusia/contracts';
import {
  ticketEvidenceReviewRequestSchema,
  ticketEvidenceReviewResponseSchema,
  type TicketEvidenceReviewService,
} from './ticket-evidence-review.js';

export interface TicketEvidenceReviewHttpDeps {
  maxBodyBytes: number;
  service?: Pick<TicketEvidenceReviewService, 'review'>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

class TicketEvidenceReviewHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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
    throw new TicketEvidenceReviewHttpError(
      413,
      'REQUEST_TOO_LARGE',
      'request body exceeds limit',
    );
  }

  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new TicketEvidenceReviewHttpError(
      400,
      'INVALID_JSON',
      'request body is not valid JSON',
    );
  }
}

function sendKnownError(
  res: http.ServerResponse,
  error: TicketEvidenceReviewHttpError,
): void {
  sendJson(res, error.status, {
    error: { code: error.code, message: error.message },
  });
}

export async function handleTicketEvidenceReviewHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: TicketEvidenceReviewHttpDeps,
): Promise<void> {
  if (deps.service === undefined) {
    sendJson(res, 503, {
      error: {
        code: 'TICKET_EVIDENCE_REVIEW_UNAVAILABLE',
        message: 'ticket evidence review service is unavailable',
      },
    });
    return;
  }

  let value: unknown;
  try {
    value = await parseBody(req, deps.maxBodyBytes);
  } catch (error) {
    if (error instanceof TicketEvidenceReviewHttpError) {
      sendKnownError(res, error);
      return;
    }
    throw error;
  }

  const parsed = ticketEvidenceReviewRequestSchema.safeParse(value);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: {
        code: 'INVALID_TICKET_EVIDENCE_REVIEW_REQUEST',
        message: 'request does not match ticket evidence review contract',
      },
    });
    return;
  }

  const traceId = extractTraceId(req.headers);
  try {
    const result = await deps.service.review(parsed.data, traceId);
    ticketEvidenceReviewResponseSchema.parse(result);
    sendJson(res, 200, result, traceId);
  } catch {
    sendJson(
      res,
      503,
      {
        error: {
          code: 'TICKET_EVIDENCE_REVIEW_FAILED',
          message: 'ticket evidence review could not be completed',
        },
      },
      traceId,
    );
  }
}
