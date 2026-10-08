import { describe, expect, it } from 'vitest';

import { verifyTicketActionRequest } from '../src/action-verification.js';
import type { ActionRequestResult } from '../src/types.js';

const submitted: ActionRequestResult = {
  requestId: 'ar-1',
  ticketId: 'T-1234',
  action: 'close',
  status: 'accepted',
  createdAt: '2026-10-08T14:00:00.000Z',
  updatedAt: '2026-10-08T14:00:00.000Z',
};

describe('ticket action verification', () => {
  it('allows a success claim only after a matching persisted accepted status', async () => {
    const reader = {
      getActionRequest: async () => ({
        ...submitted,
        updatedAt: '2026-10-08T14:00:01.000Z',
      }),
    };

    const result = await verifyTicketActionRequest(reader, submitted);

    expect(result.verification).toBe('confirmed');
    expect(result.canReportSuccess).toBe(true);
    expect(result.requestId).toBe('ar-1');
  });

  it('keeps pending requests explicitly non-successful', async () => {
    const reader = {
      getActionRequest: async () => ({
        ...submitted,
        status: 'pending' as const,
      }),
    };

    const result = await verifyTicketActionRequest(reader, submitted);

    expect(result.verification).toBe('pending');
    expect(result.canReportSuccess).toBe(false);
  });

  it('marks rejected, superseded, and expired requests not completed', async () => {
    for (const status of ['rejected', 'superseded', 'expired'] as const) {
      const reader = {
        getActionRequest: async () => ({ ...submitted, status }),
      };
      const result = await verifyTicketActionRequest(reader, submitted);
      expect(result.verification).toBe('not-completed');
      expect(result.canReportSuccess).toBe(false);
    }
  });

  it('fails safe when the persisted record does not match the submission', async () => {
    const reader = {
      getActionRequest: async () => ({
        ...submitted,
        ticketId: 'T-other',
      }),
    };

    const result = await verifyTicketActionRequest(reader, submitted);

    expect(result.verification).toBe('unverified');
    expect(result.canReportSuccess).toBe(false);
    expect(result.ticketId).toBe('T-1234');
  });

  it('preserves the request id but forbids a success claim when verification fails', async () => {
    const reader = {
      getActionRequest: async (): Promise<ActionRequestResult> => {
        throw new Error('status read unavailable');
      },
    };

    const result = await verifyTicketActionRequest(reader, submitted);

    expect(result.requestId).toBe('ar-1');
    expect(result.status).toBe('accepted');
    expect(result.verification).toBe('unverified');
    expect(result.canReportSuccess).toBe(false);
  });
});
