import { describe, expect, it, vi } from 'vitest';
import type {
  TicketContextBundle,
  TicketVideoEvidence,
} from '@enthusia/integration-ticket-bot';
import type {
  RunImageEvidenceInput,
  RunImageEvidenceResult,
} from '@enthusia/openai-gateway';
import {
  MAX_TICKET_VIDEO_ASSESSMENTS,
  aggregateFrameAssessments,
  collectTicketVideoAssessments,
  type VideoFrameObservation,
} from '../src/video-orchestrator.js';
import type { TicketVideoSample } from '../src/video-media.js';

const VIDEO_SHA = 'b'.repeat(64);
const FRAME_ONE_SHA = 'c'.repeat(64);
const FRAME_TWO_SHA = 'd'.repeat(64);

function ticket(): TicketContextBundle {
  return {
    ticket: {
      id: '42',
      category: 'report',
      subject: 'Video report ticket #42',
      status: 'open',
      priority: 'normal',
      owner: { id: 'reporter', kind: 'player' },
      assignees: [],
      createdAt: '2026-10-06T12:00:00.000Z',
      updatedAt: '2026-10-06T12:10:00.000Z',
      messageCount: 2,
    },
    messages: [
      {
        id: 'm1',
        ticketId: '42',
        author: { id: 'reporter', kind: 'player' },
        body: 'older clip',
        createdAt: '2026-10-06T12:00:00.000Z',
        attachments: [
          attachment('v1', 'old.mp4', 'video/mp4', 1000),
          attachment('x1', 'notes.txt', 'text/plain', 100),
        ],
      },
      {
        id: 'm2',
        ticketId: '42',
        author: { id: 'reporter', kind: 'player' },
        body: 'new clip',
        createdAt: '2026-10-06T12:05:00.000Z',
        attachments: [
          attachment('v2', 'new.webm', 'video/webm', 1000),
          attachment('v3', 'unsupported.mkv', 'video/x-matroska', 1000),
        ],
      },
    ],
    participants: [],
    fetchedAt: '2026-10-06T12:10:01.000Z',
  };
}

function attachment(
  id: string,
  name: string,
  contentType: string,
  size: number,
): NonNullable<TicketContextBundle['messages'][number]['attachments']>[number] {
  return { id, name, contentType, size, source: 'discord' };
}

function evidence(
  ticketId: string,
  messageId: string,
  attachmentId: string,
  contentType: TicketVideoEvidence['contentType'] = 'video/webm',
): TicketVideoEvidence {
  return {
    ticketId,
    messageId,
    attachmentId,
    contentType,
    size: 8,
    sha256: VIDEO_SHA,
    bytes: new Uint8Array([0, 0, 0, 1, 2, 3, 4, 5]),
  };
}

function sample(): TicketVideoSample {
  return {
    videoSha256: VIDEO_SHA,
    metadata: {
      durationSeconds: 4,
      width: 1280,
      height: 720,
      codec: 'vp9',
      format: 'matroska,webm',
    },
    frames: [
      {
        index: 0,
        timestampSeconds: 0,
        contentType: 'image/png',
        bytes: new Uint8Array([1]),
        sha256: FRAME_ONE_SHA,
      },
      {
        index: 1,
        timestampSeconds: 3.95,
        contentType: 'image/png',
        bytes: new Uint8Array([2]),
        sha256: FRAME_TWO_SHA,
      },
    ],
    limitation:
      'Video was sampled at 2 deterministic timestamps; events between sampled frames may not be visible.',
  };
}

function observed(input: RunImageEvidenceInput): RunImageEvidenceResult {
  const second = input.evidenceRef.includes(':frame:1@');
  return {
    assessment: {
      summary: second ? 'Second frame.' : 'First frame.',
      observations: [{
        category: 'gameplay',
        text: second ? 'A second scene is visible.' : 'A first scene is visible.',
        confidence: 0.95,
      }],
      inferences: [{
        text: second ? 'Second-frame inference.' : 'First-frame inference.',
        confidence: 0.8,
        observationIndexes: [0],
      }],
      limitations: second ? ['Motion between frames is not visible.'] : [],
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

describe('collectTicketVideoAssessments', () => {
  it('assesses only the newest bounded supported ticket video', async () => {
    const reads: string[] = [];
    const evidenceClient = {
      getVideoEvidence: async (
        ticketId: string,
        messageId: string,
        attachmentId: string,
      ) => {
        reads.push(attachmentId);
        return evidence(ticketId, messageId, attachmentId, 'video/webm');
      },
    };
    const assessImage = vi.fn(async (input: RunImageEvidenceInput) => observed(input));
    const sampleVideo = vi.fn(async () => sample());

    const result = await collectTicketVideoAssessments({
      ticket: ticket(),
      evidenceClient,
      traceId: 'trace-video',
      assessImage,
      sampleVideo,
    });

    expect(result.eligibleAttachmentCount).toBe(2);
    expect(result.attemptedCount).toBe(MAX_TICKET_VIDEO_ASSESSMENTS);
    expect(reads).toEqual(['v2']);
    expect(result.assessments).toHaveLength(1);
    expect(result.issues).toEqual(expect.arrayContaining([
      { messageId: 'm1', attachmentId: 'v1', reason: 'limit_exceeded' },
      { messageId: 'm2', attachmentId: 'v3', reason: 'unsupported_type' },
    ]));

    const record = result.assessments[0]!;
    expect(record.evidenceRef).toBe('ticket:42:message:m2:attachment:v2:video');
    expect(record.evidenceSha256).toBe(VIDEO_SHA);
    expect(record.video).toMatchObject({
      contentType: 'video/webm',
      durationSeconds: 4,
      width: 1280,
      height: 720,
      codec: 'vp9',
    });
    expect(record.video.frames).toEqual([
      {
        index: 0,
        timestampSeconds: 0,
        evidenceRef: 'ticket:42:message:m2:attachment:v2:video:frame:0@0.000s',
        sha256: FRAME_ONE_SHA,
      },
      {
        index: 1,
        timestampSeconds: 3.95,
        evidenceRef: 'ticket:42:message:m2:attachment:v2:video:frame:1@3.950s',
        sha256: FRAME_TWO_SHA,
      },
    ]);
    expect(record.assessment.observations[0]?.text).toContain('[0.000s]');
    expect(record.assessment.observations[1]?.text).toContain('[3.950s]');
    expect(record.assessment.inferences[0]?.observationIndexes).toEqual([0]);
    expect(record.assessment.inferences[1]?.observationIndexes).toEqual([1]);
    expect(record.assessment.limitations).toContain(
      'Motion between frames is not visible.',
    );
    expect(record.assessment.limitations[0]).toContain('sampled at 2');
    expect(assessImage).toHaveBeenCalledTimes(2);
  });

  it('records fetch, processing, and frame-assessment failures without exception text', async () => {
    const base = ticket();
    base.messages = [{
      id: 'm9',
      ticketId: '42',
      author: { id: 'reporter', kind: 'player' },
      body: 'video',
      createdAt: '2026-10-06T12:05:00.000Z',
      attachments: [attachment('v9', 'clip.mp4', 'video/mp4', 1000)],
    }];

    const fetchFailure = await collectTicketVideoAssessments({
      ticket: base,
      evidenceClient: {
        getVideoEvidence: async () => {
          throw new Error('private upstream detail');
        },
      },
      traceId: 'trace-fetch',
      assessImage: async (input) => observed(input),
      sampleVideo: async () => sample(),
    });
    expect(fetchFailure.issues).toEqual([
      { messageId: 'm9', attachmentId: 'v9', reason: 'fetch_failed' },
    ]);
    expect(JSON.stringify(fetchFailure)).not.toContain('private upstream detail');

    const processingFailure = await collectTicketVideoAssessments({
      ticket: base,
      evidenceClient: {
        getVideoEvidence: async (ticketId, messageId, attachmentId) =>
          evidence(ticketId, messageId, attachmentId, 'video/mp4'),
      },
      traceId: 'trace-process',
      assessImage: async (input) => observed(input),
      sampleVideo: async () => {
        throw new Error('private decoder detail');
      },
    });
    expect(processingFailure.issues).toEqual([
      { messageId: 'm9', attachmentId: 'v9', reason: 'processing_failed' },
    ]);
    expect(JSON.stringify(processingFailure)).not.toContain('private decoder detail');

    const assessmentFailure = await collectTicketVideoAssessments({
      ticket: base,
      evidenceClient: {
        getVideoEvidence: async (ticketId, messageId, attachmentId) =>
          evidence(ticketId, messageId, attachmentId, 'video/mp4'),
      },
      traceId: 'trace-assess',
      assessImage: async () => {
        throw new Error('private model detail');
      },
      sampleVideo: async () => sample(),
    });
    expect(assessmentFailure.issues).toEqual([
      { messageId: 'm9', attachmentId: 'v9', reason: 'assessment_failed' },
    ]);
    expect(JSON.stringify(assessmentFailure)).not.toContain('private model detail');
  });

  it('rejects sampler provenance drift as a processing failure', async () => {
    const base = ticket();
    base.messages = [{
      id: 'm9',
      ticketId: '42',
      author: { id: 'reporter', kind: 'player' },
      body: 'video',
      createdAt: '2026-10-06T12:05:00.000Z',
      attachments: [attachment('v9', 'clip.mp4', 'video/mp4', 1000)],
    }];
    const badSample = sample();
    badSample.videoSha256 = 'e'.repeat(64);

    const result = await collectTicketVideoAssessments({
      ticket: base,
      evidenceClient: {
        getVideoEvidence: async (ticketId, messageId, attachmentId) =>
          evidence(ticketId, messageId, attachmentId, 'video/mp4'),
      },
      traceId: 'trace-provenance',
      assessImage: async (input) => observed(input),
      sampleVideo: async () => badSample,
    });

    expect(result.assessments).toEqual([]);
    expect(result.issues).toEqual([
      { messageId: 'm9', attachmentId: 'v9', reason: 'processing_failed' },
    ]);
  });

  it('rejects frame-observer provenance drift as an assessment failure', async () => {
    const base = ticket();
    base.messages = [{
      id: 'm9',
      ticketId: '42',
      author: { id: 'reporter', kind: 'player' },
      body: 'video',
      createdAt: '2026-10-06T12:05:00.000Z',
      attachments: [attachment('v9', 'clip.mp4', 'video/mp4', 1000)],
    }];

    const result = await collectTicketVideoAssessments({
      ticket: base,
      evidenceClient: {
        getVideoEvidence: async (ticketId, messageId, attachmentId) =>
          evidence(ticketId, messageId, attachmentId, 'video/mp4'),
      },
      traceId: 'trace-frame-provenance',
      assessImage: async (input) => ({
        ...observed(input),
        evidenceRef: 'wrong-ref',
      }),
      sampleVideo: async () => sample(),
    });

    expect(result.assessments).toEqual([]);
    expect(result.issues).toEqual([
      { messageId: 'm9', attachmentId: 'v9', reason: 'assessment_failed' },
    ]);
  });

  it('refuses a fetched MIME type that does not match the ticket attachment', async () => {
    const result = await collectTicketVideoAssessments({
      ticket: ticket(),
      evidenceClient: {
        getVideoEvidence: async (ticketId, messageId, attachmentId) =>
          evidence(ticketId, messageId, attachmentId, 'video/mp4'),
      },
      traceId: 'trace-mime',
      assessImage: async (input) => observed(input),
      sampleVideo: async () => sample(),
    });
    expect(result.assessments).toEqual([]);
    expect(result.issues).toContainEqual({
      messageId: 'm2',
      attachmentId: 'v2',
      reason: 'fetch_failed',
    });
  });
});

describe('aggregateFrameAssessments', () => {
  it('remaps frame-local inference indexes into the aggregate observation list', () => {
    const frames: VideoFrameObservation[] = [
      {
        frameIndex: 0,
        timestampSeconds: 0,
        result: observed({
          traceId: 't',
          evidenceRef: 'frame-0',
          image: {
            bytes: new Uint8Array([1]),
            contentType: 'image/png',
            sha256: FRAME_ONE_SHA,
          },
        }),
      },
      {
        frameIndex: 1,
        timestampSeconds: 3.95,
        result: observed({
          traceId: 't',
          evidenceRef: 'frame-1',
          image: {
            bytes: new Uint8Array([2]),
            contentType: 'image/png',
            sha256: FRAME_TWO_SHA,
          },
        }),
      },
    ];
    const assessment = aggregateFrameAssessments(sample(), frames);
    expect(assessment.observations).toHaveLength(2);
    expect(assessment.inferences.map((item) => item.observationIndexes)).toEqual([
      [0],
      [1],
    ]);
  });
});
