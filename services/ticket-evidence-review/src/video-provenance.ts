import type { TicketVideoEvidence } from '@enthusia/integration-ticket-bot';
import {
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_FRAMES,
  MAX_VIDEO_PIXELS,
  type TicketVideoSample,
} from './video-media.js';

export function validateVideoSampleProvenance(
  evidence: TicketVideoEvidence,
  sample: TicketVideoSample,
): void {
  requireVideoHash(evidence, sample);
  requireBoundedMetadata(sample);
  requireBoundedFrames(sample);
}

function requireVideoHash(
  evidence: TicketVideoEvidence,
  sample: TicketVideoSample,
): void {
  if (sample.videoSha256.toLowerCase() === evidence.sha256.toLowerCase()) {
    return;
  }
  throw new Error('sampled video provenance mismatch');
}

function requireBoundedMetadata(sample: TicketVideoSample): void {
  requireBoundedDuration(sample.metadata.durationSeconds);
  requireBoundedDimensions(sample.metadata.width, sample.metadata.height);
  if (sample.frames.length < 1 || sample.frames.length > MAX_VIDEO_FRAMES) {
    throw new Error('sampled video metadata is outside bounded limits');
  }
}

function requireBoundedDuration(durationSeconds: number): void {
  if (
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0 &&
    durationSeconds <= MAX_VIDEO_DURATION_SECONDS
  ) {
    return;
  }
  throw new Error('sampled video metadata is outside bounded limits');
}

function requireBoundedDimensions(
  width: number,
  height: number,
): void {
  if (!isBoundedDimension(width) || !isBoundedDimension(height)) {
    throw new Error('sampled video metadata is outside bounded limits');
  }
  if (width * height > MAX_VIDEO_PIXELS) {
    throw new Error('sampled video metadata is outside bounded limits');
  }
}

function isBoundedDimension(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_VIDEO_DIMENSION
  );
}

function requireBoundedFrames(sample: TicketVideoSample): void {
  const indexes = new Set<number>();
  for (const frame of sample.frames) {
    requireFrameIndex(frame.index, indexes);
    requireFrameTimestamp(
      frame.timestampSeconds,
      sample.metadata.durationSeconds,
    );
    requireFrameHash(frame.sha256);
    indexes.add(frame.index);
  }
}

function requireFrameIndex(
  index: number,
  indexes: ReadonlySet<number>,
): void {
  if (Number.isInteger(index) && index >= 0 && !indexes.has(index)) return;
  throw new Error('sampled frame provenance is invalid');
}

function requireFrameTimestamp(
  timestampSeconds: number,
  durationSeconds: number,
): void {
  if (
    Number.isFinite(timestampSeconds) &&
    timestampSeconds >= 0 &&
    timestampSeconds <= durationSeconds
  ) {
    return;
  }
  throw new Error('sampled frame provenance is invalid');
}

function requireFrameHash(sha256: string): void {
  if (/^[a-f0-9]{64}$/.test(sha256.toLowerCase())) return;
  throw new Error('sampled frame provenance is invalid');
}
