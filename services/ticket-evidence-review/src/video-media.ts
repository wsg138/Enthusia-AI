import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TicketVideoEvidence } from '@enthusia/integration-ticket-bot';

export const MAX_VIDEO_DURATION_SECONDS = 120;
export const MAX_VIDEO_FRAMES = 3;
export const MAX_VIDEO_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_PIXELS = 2560 * 1440;
export const MAX_VIDEO_DIMENSION = 4096;
export const MAX_VIDEO_PROCESSING_MS = 30_000;
const FFPROBE_TIMEOUT_MS = 5_000;
const FFMPEG_FRAME_TIMEOUT_MS = 8_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

const SUPPORTED_VIDEO_TYPES = new Set<TicketVideoEvidence['contentType']>([
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

const SUPPORTED_CODECS = new Set([
  'h264',
  'hevc',
  'vp8',
  'vp9',
  'av1',
]);

export interface TicketVideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
  format: string;
}

export interface TicketVideoFrame {
  index: number;
  timestampSeconds: number;
  contentType: 'image/png';
  bytes: Uint8Array;
  sha256: string;
}

export interface TicketVideoSample {
  videoSha256: string;
  metadata: TicketVideoMetadata;
  frames: TicketVideoFrame[];
  limitation: string;
}

export interface MediaCommandResult {
  stdout: string;
}

export interface MediaCommandRunner {
  run(
    command: string,
    args: string[],
    options: {
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<MediaCommandResult>;
}

export interface SampleTicketVideoDeps {
  runner?: MediaCommandRunner;
  now?: () => number;
  ffprobePath?: string;
  ffmpegPath?: string;
}

export class TicketVideoProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketVideoProcessingError';
  }
}

export async function sampleTicketVideo(
  evidence: TicketVideoEvidence,
  deps: SampleTicketVideoDeps = {},
): Promise<TicketVideoSample> {
  validateSourceEvidence(evidence);
  const runner = deps.runner ?? nodeMediaCommandRunner();
  const now = deps.now ?? Date.now;
  const deadline = now() + MAX_VIDEO_PROCESSING_MS;
  const directory = await mkdtemp(join(tmpdir(), 'enthusia-ticket-video-'));
  const inputPath = join(directory, 'input-video');
  try {
    await writeFile(inputPath, evidence.bytes, { mode: 0o600 });
    const metadata = await inspectVideo(
      inputPath,
      evidence.contentType,
      runner,
      remainingTimeout(deadline, now, FFPROBE_TIMEOUT_MS),
      deps.ffprobePath ?? 'ffprobe',
    );
    const timestamps = planVideoFrameTimestamps(
      metadata.durationSeconds,
      MAX_VIDEO_FRAMES,
    );
    const frames: TicketVideoFrame[] = [];
    for (const [index, timestampSeconds] of timestamps.entries()) {
      const outputPath = join(directory, `frame-${index}.png`);
      await extractFrame(
        inputPath,
        outputPath,
        timestampSeconds,
        runner,
        remainingTimeout(deadline, now, FFMPEG_FRAME_TIMEOUT_MS),
        deps.ffmpegPath ?? 'ffmpeg',
      );
      frames.push(
        await readFrame(outputPath, index, timestampSeconds),
      );
    }
    if (frames.length === 0) {
      throw new TicketVideoProcessingError(
        'Video sampling produced no usable frames.',
      );
    }
    return {
      videoSha256: evidence.sha256.toLowerCase(),
      metadata,
      frames,
      limitation:
        `Video was sampled at ${frames.length} deterministic timestamps; ` +
        'events between sampled frames may not be visible.',
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function planVideoFrameTimestamps(
  durationSeconds: number,
  maximumFrames = MAX_VIDEO_FRAMES,
): number[] {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MAX_VIDEO_DURATION_SECONDS
  ) {
    throw new TicketVideoProcessingError(
      'Video duration is missing, invalid, or exceeds the processing limit.',
    );
  }
  if (!Number.isInteger(maximumFrames) || maximumFrames < 1) {
    throw new TicketVideoProcessingError(
      'Video frame limit must be a positive integer.',
    );
  }
  const frameCount = Math.min(
    maximumFrames,
    Math.max(1, Math.ceil(durationSeconds)),
  );
  if (frameCount === 1) return [0];

  const finalTimestamp = Math.max(0, durationSeconds - 0.05);
  return Array.from({ length: frameCount }, (_, index) =>
    roundedTimestamp((finalTimestamp * index) / (frameCount - 1)),
  );
}

function validateSourceEvidence(evidence: TicketVideoEvidence): void {
  if (!SUPPORTED_VIDEO_TYPES.has(evidence.contentType)) {
    throw new TicketVideoProcessingError('Unsupported ticket video MIME type.');
  }
  if (evidence.bytes.byteLength < 1 || evidence.bytes.byteLength > 25 * 1024 * 1024) {
    throw new TicketVideoProcessingError('Ticket video exceeds the byte limit.');
  }
  const expected = evidence.sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new TicketVideoProcessingError(
      'Ticket video requires a canonical SHA-256 provenance hash.',
    );
  }
  const actual = createHash('sha256').update(evidence.bytes).digest('hex');
  if (actual !== expected) {
    throw new TicketVideoProcessingError(
      'Ticket video bytes do not match their provenance hash.',
    );
  }
}

async function inspectVideo(
  inputPath: string,
  contentType: TicketVideoEvidence['contentType'],
  runner: MediaCommandRunner,
  timeoutMs: number,
  ffprobePath: string,
): Promise<TicketVideoMetadata> {
  let result: MediaCommandResult;
  try {
    result = await runner.run(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height,duration:format=duration,format_name',
        '-of',
        'json',
        inputPath,
      ],
      { timeoutMs, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES },
    );
  } catch {
    throw new TicketVideoProcessingError(
      'Video metadata inspection failed or timed out.',
    );
  }
  return parseVideoMetadata(result.stdout, contentType);
}

export function parseVideoMetadata(
  text: string,
  contentType: TicketVideoEvidence['contentType'],
): TicketVideoMetadata {
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
  const format = isRecord(raw.format) ? raw.format : null;
  if (!isRecord(stream) || format === null) {
    throw new TicketVideoProcessingError(
      'Video metadata did not expose a primary video stream.',
    );
  }

  const durationSeconds = firstFinitePositive(
    stream.duration,
    format.duration,
  );
  const width = finitePositiveInteger(stream.width);
  const height = finitePositiveInteger(stream.height);
  const codec = typeof stream.codec_name === 'string'
    ? stream.codec_name.trim().toLowerCase()
    : '';
  const formatName = typeof format.format_name === 'string'
    ? format.format_name.trim().toLowerCase()
    : '';

  if (
    durationSeconds === null ||
    durationSeconds > MAX_VIDEO_DURATION_SECONDS
  ) {
    throw new TicketVideoProcessingError(
      'Video duration is missing, invalid, or exceeds the processing limit.',
    );
  }
  if (
    width === null ||
    height === null ||
    width > MAX_VIDEO_DIMENSION ||
    height > MAX_VIDEO_DIMENSION ||
    width * height > MAX_VIDEO_PIXELS
  ) {
    throw new TicketVideoProcessingError(
      'Video dimensions exceed the processing limit.',
    );
  }
  if (!SUPPORTED_CODECS.has(codec)) {
    throw new TicketVideoProcessingError('Video codec is unsupported.');
  }
  if (!containerMatches(contentType, formatName)) {
    throw new TicketVideoProcessingError(
      'Video container does not match the verified MIME type.',
    );
  }

  return {
    durationSeconds,
    width,
    height,
    codec,
    format: formatName,
  };
}

async function extractFrame(
  inputPath: string,
  outputPath: string,
  timestampSeconds: number,
  runner: MediaCommandRunner,
  timeoutMs: number,
  ffmpegPath: string,
): Promise<void> {
  try {
    await runner.run(
      ffmpegPath,
      [
        '-v',
        'error',
        '-nostdin',
        '-ss',
        timestampSeconds.toFixed(3),
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-an',
        '-sn',
        '-dn',
        '-threads',
        '1',
        '-f',
        'image2',
        '-vcodec',
        'png',
        '-y',
        outputPath,
      ],
      { timeoutMs, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES },
    );
  } catch {
    throw new TicketVideoProcessingError(
      'Video frame extraction failed or timed out.',
    );
  }
}

async function readFrame(
  outputPath: string,
  index: number,
  timestampSeconds: number,
): Promise<TicketVideoFrame> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(outputPath));
  } catch {
    throw new TicketVideoProcessingError(
      'Video frame extraction did not produce an output frame.',
    );
  }
  if (
    bytes.byteLength < 8 ||
    bytes.byteLength > MAX_VIDEO_FRAME_BYTES ||
    !hasPngSignature(bytes)
  ) {
    throw new TicketVideoProcessingError(
      'Derived video frame is invalid or exceeds the frame byte limit.',
    );
  }
  return {
    index,
    timestampSeconds,
    contentType: 'image/png',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function remainingTimeout(
  deadline: number,
  now: () => number,
  perCommandMaximum: number,
): number {
  const remaining = deadline - now();
  if (remaining <= 0) {
    throw new TicketVideoProcessingError(
      'Video processing exceeded the total time limit.',
    );
  }
  return Math.max(1, Math.min(perCommandMaximum, remaining));
}

function nodeMediaCommandRunner(): MediaCommandRunner {
  return {
    run(command, args, options) {
      return new Promise((resolve, reject) => {
        execFile(
          command,
          args,
          {
            encoding: 'utf8',
            timeout: options.timeoutMs,
            maxBuffer: options.maxOutputBytes,
            windowsHide: true,
          },
          (error, stdout) => {
            if (error !== null) {
              reject(error);
              return;
            }
            resolve({ stdout });
          },
        );
      });
    },
  };
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
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function finitePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((value, index) => bytes[index] === value);
}

function roundedTimestamp(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
