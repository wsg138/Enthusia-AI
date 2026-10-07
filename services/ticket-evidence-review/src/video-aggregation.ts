import {
  MAX_IMAGE_INFERENCES,
  MAX_IMAGE_LIMITATIONS,
  MAX_IMAGE_OBSERVATIONS,
  type ImageEvidenceAssessment,
  type RunImageEvidenceResult,
} from '@enthusia/openai-gateway';
import type { TicketVideoSample } from './video-media.js';

export interface VideoFrameObservation {
  frameIndex: number;
  timestampSeconds: number;
  result: RunImageEvidenceResult;
}

export function aggregateFrameAssessments(
  sample: TicketVideoSample,
  frames: VideoFrameObservation[],
): ImageEvidenceAssessment {
  const state = createAggregationState(sample);
  appendFrameObservations(state, frames);
  appendFrameInferences(state, frames);
  return {
    summary: truncate(
      `Sampled video evidence: ${state.summaries.join(' | ')}`,
      600,
    ),
    observations: state.observations,
    inferences: state.inferences,
    limitations: state.limitations,
    needsMoreContext: state.needsMoreContext,
  };
}

interface AggregationState {
  observations: ImageEvidenceAssessment['observations'];
  inferences: ImageEvidenceAssessment['inferences'];
  limitations: string[];
  indexMap: Map<string, number>;
  summaries: string[];
  needsMoreContext: boolean;
}

function createAggregationState(
  sample: TicketVideoSample,
): AggregationState {
  return {
    observations: [],
    inferences: [],
    limitations: [sample.limitation],
    indexMap: new Map<string, number>(),
    summaries: [],
    needsMoreContext: false,
  };
}

function appendFrameObservations(
  state: AggregationState,
  frames: VideoFrameObservation[],
): void {
  for (const frame of frames) {
    appendFrameSummary(state, frame);
    appendFrameLimitations(state, frame);
    appendObservations(state, frame);
  }
}

function appendFrameSummary(
  state: AggregationState,
  frame: VideoFrameObservation,
): void {
  state.summaries.push(
    `${frame.timestampSeconds.toFixed(3)}s: ${frame.result.assessment.summary}`,
  );
  if (frame.result.assessment.needsMoreContext) {
    state.needsMoreContext = true;
  }
}

function appendFrameLimitations(
  state: AggregationState,
  frame: VideoFrameObservation,
): void {
  for (const limitation of frame.result.assessment.limitations) {
    pushUniqueBounded(
      state.limitations,
      limitation,
      MAX_IMAGE_LIMITATIONS,
    );
  }
}

function appendObservations(
  state: AggregationState,
  frame: VideoFrameObservation,
): void {
  for (const [localIndex, observation] of
    frame.result.assessment.observations.entries()) {
    if (state.observations.length >= MAX_IMAGE_OBSERVATIONS) return;
    const globalIndex = state.observations.length;
    state.indexMap.set(
      frameObservationKey(frame.frameIndex, localIndex),
      globalIndex,
    );
    state.observations.push({
      ...observation,
      text: truncate(
        `[${frame.timestampSeconds.toFixed(3)}s] ${observation.text}`,
        400,
      ),
    });
  }
}

function appendFrameInferences(
  state: AggregationState,
  frames: VideoFrameObservation[],
): void {
  for (const frame of frames) {
    appendInferences(state, frame);
    if (state.inferences.length >= MAX_IMAGE_INFERENCES) return;
  }
}

function appendInferences(
  state: AggregationState,
  frame: VideoFrameObservation,
): void {
  for (const inference of frame.result.assessment.inferences) {
    if (state.inferences.length >= MAX_IMAGE_INFERENCES) return;
    const mapped = mapObservationIndexes(state, frame, inference.observationIndexes);
    if (mapped === null) continue;
    state.inferences.push({
      ...inference,
      text: truncate(
        `[${frame.timestampSeconds.toFixed(3)}s] ${inference.text}`,
        400,
      ),
      observationIndexes: mapped,
    });
  }
}

function mapObservationIndexes(
  state: AggregationState,
  frame: VideoFrameObservation,
  localIndexes: number[],
): number[] | null {
  const mapped: number[] = [];
  for (const localIndex of localIndexes) {
    const globalIndex = state.indexMap.get(
      frameObservationKey(frame.frameIndex, localIndex),
    );
    if (globalIndex === undefined) return null;
    mapped.push(globalIndex);
  }
  return mapped;
}

function frameObservationKey(
  frameIndex: number,
  localIndex: number,
): string {
  return `${frameIndex}:${localIndex}`;
}

function pushUniqueBounded(
  values: string[],
  raw: string,
  maximum: number,
): void {
  const value = raw.trim();
  if (value.length === 0 || values.includes(value)) return;
  if (values.length >= maximum) return;
  values.push(truncate(value, 300));
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return value.slice(0, maximum - 1) + '…';
}
