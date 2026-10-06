import { createHash } from 'node:crypto';
import {
  parseTicketEvent,
  verifyWebhookSignature,
} from '@enthusia/integration-ticket-bot';
import type {
  TicketEvidenceReviewRuntime,
  TicketEvidenceRuntimeResult,
} from './ticket-evidence-runtime.js';

export interface TicketEventIngressResponse {
  status: number;
  body: {
    accepted: boolean;
    eventType?: string;
    reviewStatus?: TicketEvidenceRuntimeResult['status'];
    retryable?: boolean;
    error?: {
      code: string;
      message: string;
    };
  };
}

export class TicketEventIngress {
  constructor(
    private readonly secret: string,
    private readonly reviewer: Pick<TicketEvidenceReviewRuntime, 'review'>,
  ) {
    if (secret.length < 32) {
      throw new Error('Ticket event webhook secret must be at least 32 characters.');
    }
  }

  async handle(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<TicketEventIngressResponse> {
    if (
      signature === undefined ||
      !verifyWebhookSignature(rawBody, signature, this.secret)
    ) {
      return errorResponse(401, 'INVALID_SIGNATURE', 'ticket event signature rejected');
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return errorResponse(400, 'INVALID_JSON', 'ticket event body is not valid JSON');
    }

    let event;
    try {
      event = parseTicketEvent(raw);
    } catch {
      return errorResponse(400, 'INVALID_EVENT', 'ticket event failed validation');
    }

    if (
      event.type !== 'ticket.message' ||
      event.actor?.kind === 'system'
    ) {
      return {
        status: 200,
        body: {
          accepted: true,
          eventType: event.type,
        },
      };
    }

    let result: TicketEvidenceRuntimeResult;
    try {
      result = await this.reviewer.review(
        event.ticketId,
        traceIdForEvent(event.eventId),
        eventMessageId(event.payload),
      );
    } catch {
      return {
        status: 503,
        body: {
          accepted: false,
          eventType: event.type,
          reviewStatus: 'evidence_runtime_unavailable',
          retryable: true,
        },
      };
    }
    return {
      status: result.retryable ? 503 : 200,
      body: {
        accepted: !result.retryable,
        eventType: event.type,
        reviewStatus: result.status,
        retryable: result.retryable,
      },
    };
  }
}

function eventMessageId(
  payload: Record<string, unknown>,
): string | undefined {
  const value = payload['message_id'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function traceIdForEvent(eventId: string): string {
  const digest = createHash('sha256').update(eventId).digest('hex').slice(0, 32);
  return 'ticket-event-' + digest;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): TicketEventIngressResponse {
  return {
    status,
    body: {
      accepted: false,
      error: { code, message },
    },
  };
}
