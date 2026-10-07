import type { TicketVideoEvidence } from '@enthusia/integration-ticket-bot';
import {
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_PIXELS,
  TicketVideoProcessingError,
} from './video-media.js';

const SUPPORTED_CODECS = new Set([
  'h264',
  'hevc',
  'vp8',
  'vp9',
  'av1',
]);

export function parseVideoMetadata(
  text: string,
  contentType: TicketVideoEvidence['contentType'],
): {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
  format: string;
} {
  const { stream, format } = parseProbeOutput(text);
  const durationSeconds = requireDuration(stream, format);
  const { width, height } = requireDimensions(stream);
  const codec = requireCodec(stream);
  const formatName = requireFormatName(format);
  requireMatchingContainer(contentType, formatName);
  return {
    durationSeconds,
    width,
    height,
    codec,
    format: formatName,
  };
}

function parseProbeOutput(text: string): {
  stream: Record<string, unknown>;
  format: Record<string, unknown>;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TicketVideoProcessingError(
      'Video metadata output was not valid JSON.',
    );
  }
  if (!isRecord(raw)) {
    throw new TicketVideoProcessingError('Video metadata shape is invalid.');
  }
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const stream = streams[0];
  const format = raw.format;
  if (!isRecord(stream) || !isRecord(format)) {
    throw new TicketVideoProcessingError(
      'Video metadata did not expose a primary video stream.',
    );
  }
  return { stream, format };
}

function requireDuration(
  stream: Record<string, unknown>,
  format: Record<string, unknown>,
): number {
  const duration = firstFinitePositive(stream.duration, format.duration);
  if (duration !== null && duration <= MAX_VIDEO_DURATION_SECONDS) {
    return duration;
  }
  throw new TicketVideoProcessingError(
    'Video duration is missing, invalid, or exceeds the processing limit.',
  );
}

function requireDimensions(
  stream: Record<string, unknown>,
): { width: number; height: number } {
  const width = finitePositiveInteger(stream.width);
  const height = finitePositiveInteger(stream.height);
  if (
    width !== null &&
    height !== null &&
    width <= MAX_VIDEO_DIMENSION &&
    height <= MAX_VIDEO_DIMENSION &&
    width * height <= MAX_VIDEO_PIXELS
  ) {
    return { width, height };
  }
  throw new TicketVideoProcessingError(
    'Video dimensions exceed the processing limit.',
  );
}

function requireCodec(stream: Record<string, unknown>): string {
  const value = stream.codec_name;
  const codec = typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';
  if (SUPPORTED_CODECS.has(codec)) return codec;
  throw new TicketVideoProcessingError('Video codec is unsupported.');
}

function requireFormatName(format: Record<string, unknown>): string {
  const value = format.format_name;
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim().toLowerCase();
  }
  throw new TicketVideoProcessingError(
    'Video metadata did not expose a container format.',
  );
}

function requireMatchingContainer(
  contentType: TicketVideoEvidence['contentType'],
  formatName: string,
): void {
  if (containerMatches(contentType, formatName)) return;
  throw new TicketVideoProcessingError(
    'Video container does not match the verified MIME type.',
  );
}

function containerMatches(
  contentType: TicketVideoEvidence['contentType'],
  formatName: string,
): boolean {
  const formats = new Set(formatName.split(',').map((item) => item.trim()));
  if (contentType === 'video/webm') {
    return formats.has('webm') || formats.has('matroska');
  }
  return formats.has('mov') || formats.has('mp4');
}

function firstFinitePositive(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numericValue(value);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finitePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
