import { describe, expect, it, vi } from 'vitest';
import type {
  TicketContextBundle,
  TicketImageEvidence,
} from '@enthusia/integration-ticket-bot';
import type {
  RunImageEvidenceInput,
  RunImageEvidenceResult,
} from '@enthusia/openai-gateway';
import {
  MAX_TICKET_IMAGE_ASSESSMENTS,
  collectTicketImageAssessments,
} from '../src/orchestrator.js';

const SHA = 'a'.repeat(64);

function ticket(): TicketContextBundle {
  return {
    ticket: {
      id: '42',
      category: 'report',
      subject: 'Player report ticket #42',
      status: 'open',
      priority: 'normal',
      owner: { id: 'reporter', kind: 'player' },
      assignees: [],
      createdAt: '2026-10-06T12:00:00.000Z',
      updatedAt: '2026-10-06T12:10:00.000Z',
      messageCount: 2,
    },
    messages: ticketMessages(),
    participants: [],
    fetchedAt: '2026-10-06T12:10:01.000Z',
  };
}

function ticketMessages(): TicketContextBundle['messages'] {
  return [
    {
      id: 'm1',
      ticketId: '42',
      author: { id: 'reporter', kind: 'player' },
      body: 'first',
      createdAt: '2026-10-06T12:00:00.000Z',
      attachments: [
        attachment('1001', 'old.png', 'image/png'),
        attachment('1002', 'notes.pdf', 'application/pdf'),
      ],
    },
    {
      id: 'm2',
      ticketId: '42',
      author: { id: 'reporter', kind: 'player' },
      body: 'newer',
      createdAt: '2026-10-06T12:05:00.000Z',
      attachments: [
        attachment('1003', 'one.jpg', 'image/jpeg'),
        attachment('1004', 'two.webp', 'image/webp'),
        attachment('1005', 'three.gif', 'image/gif'),
      ],
    },
  ];
}

function attachment(
  id: string,
  name: string,
  contentType: string,
): NonNullable<TicketContextBundle['messages'][number]['attachments']>[number] {
  return {
    id,
    name,
    contentType,
    size: 100,
    source: 'discord',
  };
}

function evidence(
  ticketId: string,
  messageId: string,
  attachmentId: string,
  contentType = 'image/png',
): TicketImageEvidence {
  return {
    ticketId,
    messageId,
    attachmentId,
    contentType,
    size: 4,
    sha256: SHA,
    bytes: new Uint8Array([1, 2, 3, 4]),
  };
}

function observed(input: RunImageEvidenceInput): RunImageEvidenceResult {
  return {
    assessment: {
      summary: 'Observed ticket screenshot.',
      observations: [{
        category: 'game_ui',
        text: 'Minecraft UI is visible.',
        confidence: 0.99,
      }],
      inferences: [],
      limitations: [],
      needsMoreContext: false,
    },
    evidenceRef: input.evidenceRef,
    evidenceSha256: input.image.sha256,
    model: 'vision-test',
    usage: {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    },
    estimatedCostUsd: 0.01,
  };
}

describe('collectTicketImageAssessments', () => {
  it('assesses only the newest bounded supported ticket images', async () => {
    const reads: string[] = [];
    const evidenceClient = {
      getImageEvidence: async (
        ticketId: string,
        messageId: string,
        attachmentId: string,
      ) => {
        reads.push(attachmentId);
        const contentType =
          attachmentId === '1003'
            ? 'image/jpeg'
            : attachmentId === '1004'
              ? 'image/webp'
              : 'image/gif';
        return evidence(ticketId, messageId, attachmentId, contentType);
      },
    };
    const assessImage = vi.fn(async (input: RunImageEvidenceInput) => observed(input));

    const result = await collectTicketImageAssessments({
      ticket: ticket(),
      evidenceClient,
      traceId: 'trace-42',
      assessImage,
    });

    expect(result.eligibleAttachmentCount).toBe(4);
    expect(result.attemptedCount).toBe(MAX_TICKET_IMAGE_ASSESSMENTS);
    expect(reads).toEqual(['1003', '1004', '1005']);
    expect(result.assessments).toHaveLength(3);
    expect(result.issues).toEqual(expect.arrayContaining([
      { messageId: 'm1', attachmentId: '1001', reason: 'limit_exceeded' },
      { messageId: 'm1', attachmentId: '1002', reason: 'unsupported_type' },
    ]));
    expect(assessImage).toHaveBeenCalledTimes(3);
    const first = assessImage.mock.calls[0]?.[0];
    expect(first?.traceId).toBe('trace-42');
    expect(first?.evidenceRef).toBe('ticket:42:message:m2:attachment:1003');
    expect(first?.context?.ticketCategory).toBe('report');
  });

  it('records fetch and assessment failures without leaking exception text', async () => {
    const evidenceClient = {
      getImageEvidence: async (
        ticketId: string,
        messageId: string,
        attachmentId: string,
      ) => {
        if (attachmentId === '1004') throw new Error('private upstream detail');
        return evidence(ticketId, messageId, attachmentId, 'image/jpeg');
      },
    };
    const assessImage = vi.fn(async (input: RunImageEvidenceInput) => {
      if (input.evidenceRef.endsWith(':1005')) {
        throw new Error('private model detail');
      }
      return observed(input);
    });

    const result = await collectTicketImageAssessments({
      ticket: ticket(),
      evidenceClient,
      traceId: 'trace-failure',
      maxImages: 3,
      assessImage,
    });

    expect(result.assessments).toHaveLength(1);
    expect(result.issues).toEqual(expect.arrayContaining([
      { messageId: 'm2', attachmentId: '1004', reason: 'fetch_failed' },
      { messageId: 'm2', attachmentId: '1005', reason: 'assessment_failed' },
    ]));
    expect(JSON.stringify(result)).not.toContain('private upstream detail');
    expect(JSON.stringify(result)).not.toContain('private model detail');
  });

  it('does not require OpenAI configuration when no supported image exists', async () => {
    const noImages = ticket();
    noImages.messages = [{
      id: 'm3',
      ticketId: '42',
      author: { id: 'reporter', kind: 'player' },
      body: 'text',
      createdAt: '2026-10-06T12:00:00.000Z',
      attachments: [{
        id: '2001',
        name: 'notes.txt',
        contentType: 'text/plain',
        size: 10,
        source: 'discord',
      }],
    }];

    const result = await collectTicketImageAssessments({
      ticket: noImages,
      evidenceClient: {
        getImageEvidence: async () => {
          throw new Error('must not be called');
        },
      },
      traceId: 'trace-no-images',
    });

    expect(result.assessments).toEqual([]);
    expect(result.attemptedCount).toBe(0);
    expect(result.issues).toEqual([
      { messageId: 'm3', attachmentId: '2001', reason: 'unsupported_type' },
    ]);
  });
});
