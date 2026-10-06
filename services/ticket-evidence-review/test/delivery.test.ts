import { describe, expect, it, vi } from 'vitest';
import type { ActionRequestInput } from '@enthusia/integration-ticket-bot';
import {
  deliverTicketEvidenceReview,
  evidenceReviewCorrelationId,
} from '../src/delivery.js';
import type {
  TicketEvidenceReviewResult,
  TicketImageAssessmentRecord,
} from '../src/types.js';

const SHA = 'b'.repeat(64);

function evidence(ref = 'ticket:42:message:m1:attachment:a1'): TicketImageAssessmentRecord {
  return {
    messageId: 'm1',
    attachmentId: 'a1',
    evidenceRef: ref,
    evidenceSha256: SHA,
    assessment: {
      summary: 'Evidence.',
      observations: [{
        category: 'visible_text',
        text: 'Visible fact.',
        confidence: 0.95,
      }],
      inferences: [],
      limitations: [],
      needsMoreContext: false,
    },
  };
}

function review(shouldEscalate: boolean): TicketEvidenceReviewResult {
  return {
    disposition: shouldEscalate ? 'staff_review' : 'needs_more_evidence',
    target: { kind: 'minecraft_username', value: 'Bad_Player' },
    confidence: 0.91,
    summary: shouldEscalate
      ? 'Review Bad_Player. AI analysis is advisory; staff retains punishment authority.'
      : 'More evidence is required.',
    observedFacts: ['Visible fact.'],
    concerns: [],
    limitations: [],
    missingEvidence: shouldEscalate ? [] : ['More context.'],
    moderationState: {
      availability: 'unavailable',
      target: 'Bad_Player',
      duplicateStatus: 'none',
      activeSanctions: [],
    },
    shouldEscalate,
  };
}

describe('deliverTicketEvidenceReview', () => {
  it('does nothing when the deterministic review does not request staff escalation', async () => {
    const requestAction = vi.fn();
    const result = await deliverTicketEvidenceReview({
      ticketId: '42',
      review: review(false),
      imageEvidence: [evidence()],
      ticketClient: { requestAction },
    });

    expect(result).toBeNull();
    expect(requestAction).not.toHaveBeenCalled();
  });

  it('submits one idempotent Ticket Bot escalation request with bounded metadata', async () => {
    const requestAction = vi.fn(async (
      ticketId: string,
      input: ActionRequestInput,
    ) => ({
      requestId: 'ar-1',
      ticketId,
      action: input.action,
      status: 'accepted' as const,
      createdAt: '2026-10-06T12:00:00.000Z',
      updatedAt: '2026-10-06T12:00:01.000Z',
    }));

    const item = evidence();
    const result = await deliverTicketEvidenceReview({
      ticketId: '42',
      review: review(true),
      imageEvidence: [item],
      ticketClient: { requestAction },
    });

    expect(result?.status).toBe('accepted');
    expect(requestAction).toHaveBeenCalledTimes(1);
    const call = requestAction.mock.calls[0];
    expect(call?.[0]).toBe('42');
    expect(call?.[1]).toMatchObject({
      action: 'escalate',
      reason: expect.stringContaining('staff retains punishment authority'),
      parameters: {
        extra: {
          source: 'ticket-evidence-review',
          disposition: 'staff_review',
          confidence: 0.91,
          evidenceRefs: [item.evidenceRef],
        },
      },
    });
    expect(call?.[1].correlationId).toMatch(/^evidence-review:42:[a-f0-9]{32}$/);
  });

  it('uses the same correlation id for the same evidence regardless of order', () => {
    const one = evidence('ticket:42:message:m1:attachment:a1');
    const two = {
      ...evidence('ticket:42:message:m2:attachment:a2'),
      attachmentId: 'a2',
      messageId: 'm2',
      evidenceSha256: 'c'.repeat(64),
    };

    expect(evidenceReviewCorrelationId('42', [one, two]))
      .toBe(evidenceReviewCorrelationId('42', [two, one]));
    expect(evidenceReviewCorrelationId('42', [one]))
      .not.toBe(evidenceReviewCorrelationId('42', [one, two]));
  });
});
