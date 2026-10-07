import { describe, expect, it, vi } from 'vitest';
import type {
  TicketContextBundle,
  TicketImageEvidence,
  TicketVideoEvidence,
} from '@enthusia/integration-ticket-bot';
import type {
  RunImageEvidenceInput,
  RunImageEvidenceResult,
} from '@enthusia/openai-gateway';
import { collectTicketVisualAssessments } from '../src/visual-orchestrator.js';
import type { TicketVideoSample } from '../src/video-media.js';

const VIDEO_SHA = 'b'.repeat(64);

function ticket(): TicketContextBundle {
  return {
    ticket: {
      id: '42',
      category: 'report',
      subject: 'Mixed evidence',
      status: 'open',
      priority: 'normal',
      owner: { id: 'reporter', kind: 'player' },
      assignees: [],
      createdAt: '2026-10-06T12:00:00.000Z',
      updatedAt: '2026-10-06T12:05:00.000Z',
      messageCount: 1,
    },
    messages: [{
      id: 'm1',
      ticketId: '42',
      author: { id: 'reporter', kind: 'player' },
      body: 'Mixed evidence.',
      createdAt: '2026-10-06T12:01:00.000Z',
      attachments: [
        attachment('v1', 'clip.mp4', 'video/mp4'),
        attachment('i1', 'one.png', 'image/png'),
        attachment('i2', 'two.jpg', 'image/jpeg'),
      ],
    }],
    participants: [],
    fetchedAt: '2026-10-06T12:05:01.000Z',
  };
}

function attachment(id: string, name: string, contentType: string) {
  return { id, name, contentType, size: 100, source: 'discord' as const };
}

function videoEvidence(): TicketVideoEvidence {
  return {
    ticketId: '42',
    messageId: 'm1',
    attachmentId: 'v1',
    contentType: 'video/mp4',
    size: 8,
    sha256: VIDEO_SHA,
    bytes: new Uint8Array([0, 0, 0, 1, 2, 3, 4, 5]),
  };
}

function imageEvidence(attachmentId: string): TicketImageEvidence {
  return {
    ticketId: '42',
    messageId: 'm1',
    attachmentId,
    contentType: attachmentId === 'i1' ? 'image/png' : 'image/jpeg',
    size: 4,
    sha256: 'a'.repeat(64),
    bytes: new Uint8Array([1, 2, 3, 4]),
  };
}

function sample(frameCount: number): TicketVideoSample {
  return {
    videoSha256: VIDEO_SHA,
    metadata: {
      durationSeconds: 4,
      width: 1280,
      height: 720,
      codec: 'h264',
      format: 'mov,mp4,m4a,3gp,3g2,mj2',
    },
    frames: Array.from({ length: frameCount }, (_, index) => ({
      index,
      timestampSeconds: index,
      contentType: 'image/png' as const,
      bytes: new Uint8Array([index + 1]),
      sha256: String(index + 1).repeat(64),
    })),
    limitation: 'Sampled frames may miss events between timestamps.',
  };
}

function observed(input: RunImageEvidenceInput): RunImageEvidenceResult {
  return {
    assessment: {
      summary: 'Observed visual evidence.',
      observations: [{
        category: 'gameplay',
        text: 'A gameplay scene is visible.',
        confidence: 0.95,
      }],
      inferences: [],
      limitations: [],
      needsMoreContext: false,
    },
    evidenceRef: input.evidenceRef,
    evidenceSha256: input.image.sha256,
    model: 'vision-test',
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    },
    estimatedCostUsd: 0,
  };
}

describe('ticket-wide visual assessment budget', () => {
  it('uses zero screenshot calls after a three-frame video', async () => {
    const getImageEvidence = vi.fn(async (
      _ticketId: string,
      _messageId: string,
      attachmentId: string,
    ) => imageEvidence(attachmentId));
    const assessImage = vi.fn(async (input: RunImageEvidenceInput) => observed(input));

    const result = await collectTicketVisualAssessments({
      ticket: ticket(),
      evidenceClient: {
        getVideoEvidence: async () => videoEvidence(),
        getImageEvidence,
      },
      traceId: 'trace-budget-3',
      assessImage,
      sampleVideo: async () => sample(3),
    });

    expect(assessImage).toHaveBeenCalledTimes(3);
    expect(getImageEvidence).not.toHaveBeenCalled();
    expect(result.videoAssessmentCount).toBe(1);
    expect(result.imageAssessmentCount).toBe(0);
    expect(result.issues).toEqual(expect.arrayContaining([
      { messageId: 'm1', attachmentId: 'i1', reason: 'limit_exceeded' },
      { messageId: 'm1', attachmentId: 'i2', reason: 'limit_exceeded' },
    ]));
  });

  it('allows exactly one screenshot call after a two-frame video', async () => {
    const getImageEvidence = vi.fn(async (
      _ticketId: string,
      _messageId: string,
      attachmentId: string,
    ) => imageEvidence(attachmentId));
    const assessImage = vi.fn(async (input: RunImageEvidenceInput) => observed(input));

    const result = await collectTicketVisualAssessments({
      ticket: ticket(),
      evidenceClient: {
        getVideoEvidence: async () => videoEvidence(),
        getImageEvidence,
      },
      traceId: 'trace-budget-2',
      assessImage,
      sampleVideo: async () => sample(2),
    });

    expect(assessImage).toHaveBeenCalledTimes(3);
    expect(getImageEvidence).toHaveBeenCalledTimes(1);
    expect(result.videoAssessmentCount).toBe(1);
    expect(result.imageAssessmentCount).toBe(1);
    expect(result.assessments).toHaveLength(2);
  });
});
