import { describe, expect, it } from 'vitest';
import type {
  TicketContextBundle,
  TicketMessage,
} from '@enthusia/integration-ticket-bot';
import type { ImageEvidenceAssessment } from '@enthusia/openai-gateway';
import {
  EvidenceReviewValidationError,
  reviewTicketEvidence,
} from '../src/review.js';
import type {
  AuthoritativeModerationState,
  EvidencePolicyConcern,
  TicketImageAssessmentRecord,
} from '../src/types.js';

const MESSAGE_ID = '120000000000000001';
const ATTACHMENT_ID = '120000000000000002';
const EVIDENCE_REF = 'ticket:42:message:120000000000000001:attachment:120000000000000002';
const SHA = 'a'.repeat(64);

function bundle(overrides: Partial<TicketContextBundle['ticket']> = {}): TicketContextBundle {
  const message: TicketMessage = {
    id: MESSAGE_ID,
    ticketId: '42',
    author: { id: 'reporter-1', kind: 'player', displayName: 'Reporter' },
    body: 'Evidence attached.',
    createdAt: '2026-10-06T12:00:00.000Z',
    attachments: [{
      id: ATTACHMENT_ID,
      name: 'evidence.png',
      contentType: 'image/png',
      size: 4096,
      source: 'discord',
    }],
  };
  return {
    ticket: {
      id: '42',
      category: 'report',
      subject: 'Player report ticket #42',
      status: 'open',
      priority: 'normal',
      owner: { id: 'reporter-1', kind: 'player', displayName: 'Reporter' },
      assignees: [],
      channelId: 'channel-42',
      createdAt: '2026-10-06T12:00:00.000Z',
      updatedAt: '2026-10-06T12:05:00.000Z',
      messageCount: 1,
      metadata: {
        reportTarget: {
          kind: 'minecraft_username',
          value: 'Bad_Player',
        },
      },
      ...overrides,
    },
    messages: [message],
    participants: [message.author],
    fetchedAt: '2026-10-06T12:06:00.000Z',
  };
}

function assessment(
  overrides: Partial<ImageEvidenceAssessment> = {},
): ImageEvidenceAssessment {
  return {
    summary: 'Minecraft chat screenshot.',
    observations: [{
      category: 'visible_text',
      text: 'A visible chat line contains the reported text.',
      confidence: 0.96,
    }],
    inferences: [],
    limitations: [],
    needsMoreContext: false,
    ...overrides,
  };
}

function evidence(
  overrides: Partial<TicketImageAssessmentRecord> = {},
): TicketImageAssessmentRecord {
  return {
    messageId: MESSAGE_ID,
    attachmentId: ATTACHMENT_ID,
    evidenceRef: EVIDENCE_REF,
    evidenceSha256: SHA,
    assessment: assessment(),
    ...overrides,
  };
}

function moderation(
  overrides: Partial<AuthoritativeModerationState> = {},
): AuthoritativeModerationState {
  return {
    availability: 'verified',
    target: 'Bad_Player',
    duplicateStatus: 'none',
    activeSanctions: [],
    fetchedAt: '2026-10-06T12:06:00.000Z',
    ...overrides,
  };
}

function concern(
  overrides: Partial<EvidencePolicyConcern> = {},
): EvidencePolicyConcern {
  return {
    code: 'chat.harassment',
    label: 'Possible harassment',
    severity: 'high',
    confidence: 0.91,
    evidenceRefs: [EVIDENCE_REF],
    summary: 'Visible text may violate the harassment rule.',
    ...overrides,
  };
}

describe('reviewTicketEvidence', () => {
  it('escalates a clear provenance-linked concern for staff review only', () => {
    const result = reviewTicketEvidence({
      ticket: bundle(),
      imageEvidence: [evidence()],
      concerns: [concern()],
      moderationState: moderation(),
    });

    expect(result.disposition).toBe('staff_review');
    expect(result.shouldEscalate).toBe(true);
    expect(result.target?.value).toBe('Bad_Player');
    expect(result.summary).toContain('staff retains punishment authority');
    expect(result.observedFacts).toContain(
      'A visible chat line contains the reported text.',
    );
  });

  it('suppresses duplicate staff escalation only for an authoritative match', () => {
    const result = reviewTicketEvidence({
      ticket: bundle(),
      imageEvidence: [evidence()],
      concerns: [concern()],
      moderationState: moderation({ duplicateStatus: 'actioned' }),
    });

    expect(result.disposition).toBe('already_actioned');
    expect(result.shouldEscalate).toBe(false);
  });

  it('does not treat unrelated active sanctions as a duplicate report', () => {
    const result = reviewTicketEvidence({
      ticket: bundle(),
      imageEvidence: [evidence()],
      concerns: [concern()],
      moderationState: moderation({
        activeSanctions: [{
          id: 'sanction-old',
          type: 'MUTE',
          status: 'ACTIVE',
          reason: 'Unrelated spam case',
        }],
      }),
    });

    expect(result.disposition).toBe('staff_review');
    expect(result.shouldEscalate).toBe(true);
  });

  it('asks for more evidence when the image is cropped or ambiguous', () => {
    const result = reviewTicketEvidence({
      ticket: bundle(),
      imageEvidence: [evidence({
        assessment: assessment({
          observations: [{
            category: 'visible_text',
            text: 'Only part of a chat message is visible.',
            confidence: 0.72,
          }],
          limitations: ['The screenshot is cropped before the preceding messages.'],
          needsMoreContext: true,
        }),
      })],
      concerns: [concern({ confidence: 0.72 })],
      moderationState: moderation(),
    });

    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.shouldEscalate).toBe(false);
    expect(result.missingEvidence.join(' ')).toMatch(/wider|cropped/i);
  });

  it('does not escalate clear benign evidence with no rule-aware concern', () => {
    const result = reviewTicketEvidence({
      ticket: bundle(),
      imageEvidence: [evidence()],
      concerns: [],
      moderationState: moderation(),
    });

    expect(result.disposition).toBe('no_escalation');
    expect(result.shouldEscalate).toBe(false);
  });

  it('fails closed when a report target is missing', () => {
    const result = reviewTicketEvidence({
      ticket: bundle({ metadata: {} }),
      imageEvidence: [evidence()],
      concerns: [concern()],
      moderationState: moderation({ availability: 'unavailable', target: '' }),
    });

    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.target).toBeNull();
    expect(result.shouldEscalate).toBe(false);
  });

  it('rejects image evidence that is not linked to the ticket attachment', () => {
    expect(() => reviewTicketEvidence({
      ticket: bundle(),
      imageEvidence: [evidence({ attachmentId: '999999999999999999' })],
      concerns: [],
      moderationState: moderation(),
    })).toThrow(EvidenceReviewValidationError);
  });

  it('rejects policy concerns that cite evidence outside this review', () => {
    expect(() => reviewTicketEvidence({
      ticket: bundle(),
      imageEvidence: [evidence()],
      concerns: [concern({ evidenceRefs: ['other:evidence'] })],
      moderationState: moderation(),
    })).toThrow(/outside this ticket review/);
  });

  it('rejects verified moderation state for a different target', () => {
    expect(() => reviewTicketEvidence({
      ticket: bundle(),
      imageEvidence: [evidence()],
      concerns: [],
      moderationState: moderation({ target: 'SomeoneElse' }),
    })).toThrow(/does not match/);
  });
});
