import { describe, expect, it } from 'vitest';
import type {
  RunImageEvidenceInput,
  RunImageEvidenceResult,
} from '@enthusia/openai-gateway';
import {
  aggregateFrameAssessments,
  type VideoFrameObservation,
} from '../src/video-orchestrator.js';
import type { TicketVideoSample } from '../src/video-media.js';

const FRAME_ONE_SHA = 'c'.repeat(64);
const FRAME_TWO_SHA = 'd'.repeat(64);

function sample(): TicketVideoSample {
  return {
    videoSha256: 'b'.repeat(64),
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
  const second = input.evidenceRef.includes('frame-1');
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

function frame(
  index: number,
  timestampSeconds: number,
  sha256: string,
): VideoFrameObservation {
  const input: RunImageEvidenceInput = {
    traceId: 't',
    evidenceRef: `frame-${index}`,
    image: {
      bytes: new Uint8Array([index + 1]),
      contentType: 'image/png',
      sha256,
    },
  };
  return {
    frameIndex: index,
    timestampSeconds,
    result: observed(input),
  };
}

describe('aggregateFrameAssessments', () => {
  it('remaps frame-local inference indexes into the aggregate observation list', () => {
    const assessment = aggregateFrameAssessments(sample(), [
      frame(0, 0, FRAME_ONE_SHA),
      frame(1, 3.95, FRAME_TWO_SHA),
    ]);
    expect(assessment.observations).toHaveLength(2);
    expect(assessment.inferences.map((item) => item.observationIndexes)).toEqual([
      [0],
      [1],
    ]);
  });

  it('preserves contradictory frames and overlay limitations instead of resolving them', () => {
    const first = frame(0, 0, FRAME_ONE_SHA);
    first.result.assessment.observations[0]!.text =
      'The reported player appears next to the disputed structure.';

    const second = frame(1, 3.95, FRAME_TWO_SHA);
    second.result.assessment.observations[0]!.text =
      'The reported player is not visible in this sampled frame.';
    second.result.assessment.limitations = [
      'A large edited overlay obscures part of the gameplay view.',
    ];
    second.result.assessment.needsMoreContext = true;

    const assessment = aggregateFrameAssessments(sample(), [first, second]);

    expect(assessment.observations.map((item) => item.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('appears next to the disputed structure'),
        expect.stringContaining('is not visible'),
      ]),
    );
    expect(assessment.limitations).toContain(
      'A large edited overlay obscures part of the gameplay view.',
    );
    expect(assessment.needsMoreContext).toBe(true);
  });
});
