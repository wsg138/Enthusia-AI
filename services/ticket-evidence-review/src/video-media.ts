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
import {
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_FRAME_BYTES,
  MAX_VIDEO_FRAMES,
  MAX_VIDEO_PROCESSING_MS,
  TicketVideoProcessingError,
} from './video-constraints.js';
import { parseVideoMetadata } from './video-metadata.js';

export {
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_FRAME_BYTES,
  MAX_VIDEO_FRAMES,
  MAX_VIDEO_PIXELS,
  MAX_VIDEO_PROCESSING_MS,
  TicketVideoProcessingError,
} from './video-constraints.js';
export { parseVideoMetadata } from './video-metadata.js';

const FFPROBE_TIMEOUT_MS = 5_000;
const FFMPEG_FRAME_TIMEOUT_MS = 8_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_VIDEO_SOURCE_BYTES = 25 * 1024 * 1024;

const SUPPORTED_VIDEO_TYPES = new Set<TicketVideoEvidence['contentType']>([
  'video/mp4',
  'video/webm',
  'video/quicktime',
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

interface ResolvedSamplingDeps {
  runner: MediaCommandRunner;
  now: () => number;
  ffprobePath: string;
  ffmpegPath: string;
}

interface SamplingContext extends ResolvedSamplingDeps {
  evidence: TicketVideoEvidence;
  deadline: number;
  directory: string;
  inputPath: string;
}

export async function sampleTicketVideo(
  evidence: TicketVideoEvidence,
  deps: SampleTicketVideoDeps = {},
): Promise<TicketVideoSample> {
  validateSourceEvidence(evidence);
  const context = await createSamplingContext(evidence, deps);
  try {
    return await samplePreparedVideo(context);
  } finally {
    await rm(context.directory, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

async function createSamplingContext(
  evidence: TicketVideoEvidence,
  deps: SampleTicketVideoDeps,
): Promise<SamplingContext> {
  const resolved = resolveSamplingDeps(deps);
  const directory = await mkdtemp(join(tmpdir(), 'enthusia-ticket-video-'));
  const inputPath = join(directory, 'input-video');
  await writeFile(inputPath, evidence.bytes, { mode: 0o600 });
  return {
    ...resolved,
    evidence,
    deadline: resolved.now() + MAX_VIDEO_PROCESSING_MS,
    directory,
    inputPath,
  };
}

function resolveSamplingDeps(
  deps: SampleTicketVideoDeps,
): ResolvedSamplingDeps {
  const now = deps.now ?? Date.now;
  return {
    runner: deps.runner ?? nodeMediaCommandRunner(),
    now,
    ffprobePath: deps.ffprobePath ?? 'ffprobe',
    ffmpegPath: deps.ffmpegPath ?? 'ffmpeg',
  };
}

async function samplePreparedVideo(
  context: SamplingContext,
): Promise<TicketVideoSample> {
  const metadata = await inspectVideo(
    context.inputPath,
    context.evidence.contentType,
    context.runner,
    remainingTimeout(
      context.deadline,
      context.now,
      FFPROBE_TIMEOUT_MS,
    ),
    context.ffprobePath,
  );
  const frames = await sampleFrames(context, metadata);
  return buildVideoSample(context.evidence, metadata, frames);
}

async function sampleFrames(
  context: SamplingContext,
  metadata: TicketVideoMetadata,
): Promise<TicketVideoFrame[]> {
  const timestamps = planVideoFrameTimestamps(
    metadata.durationSeconds,
    MAX_VIDEO_FRAMES,
  );
  const frames: TicketVideoFrame[] = [];
  for (const [index, timestampSeconds] of timestamps.entries()) {
    frames.push(await sampleFrame(context, index, timestampSeconds));
  }
  if (frames.length > 0) return frames;
  throw new TicketVideoProcessingError(
    'Video sampling produced no usable frames.',
  );
}

async function sampleFrame(
  context: SamplingContext,
  index: number,
  timestampSeconds: number,
): Promise<TicketVideoFrame> {
  const outputPath = join(context.directory, `frame-${index}.png`);
  await extractFrame(
    context.inputPath,
    outputPath,
    timestampSeconds,
    context.runner,
    remainingTimeout(
      context.deadline,
      context.now,
      FFMPEG_FRAME_TIMEOUT_MS,
    ),
    context.ffmpegPath,
  );
  return readFrame(outputPath, index, timestampSeconds);
}

function buildVideoSample(
  evidence: TicketVideoEvidence,
  metadata: TicketVideoMetadata,
  frames: TicketVideoFrame[],
): TicketVideoSample {
  return {
    videoSha256: evidence.sha256.toLowerCase(),
    metadata,
    frames,
    limitation:
      `Video was sampled at ${frames.length} deterministic timestamps; ` +
      'events between sampled frames may not be visible.',
  };
}

export function planVideoFrameTimestamps(
  durationSeconds: number,
  maximumFrames = MAX_VIDEO_FRAMES,
): number[] {
  validateTimestampPlanInput(durationSeconds, maximumFrames);
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

function validateTimestampPlanInput(
  durationSeconds: number,
  maximumFrames: number,
): void {
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
}

function validateSourceEvidence(evidence: TicketVideoEvidence): void {
  if (!SUPPORTED_VIDEO_TYPES.has(evidence.contentType)) {
    throw new TicketVideoProcessingError('Unsupported ticket video MIME type.');
  }
  if (
    evidence.bytes.byteLength < 1 ||
    evidence.bytes.byteLength > MAX_VIDEO_SOURCE_BYTES
  ) {
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
      ffprobeArgs(inputPath),
      { timeoutMs, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES },
    );
  } catch {
    throw new TicketVideoProcessingError(
      'Video metadata inspection failed or timed out.',
    );
  }
  return parseVideoMetadata(result.stdout, contentType);
}

function ffprobeArgs(inputPath: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name,width,height,duration:format=duration,format_name',
    '-of',
    'json',
    inputPath,
  ];
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
      ffmpegFrameArgs(inputPath, outputPath, timestampSeconds),
      { timeoutMs, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES },
    );
  } catch {
    throw new TicketVideoProcessingError(
      'Video frame extraction failed or timed out.',
    );
  }
}

function ffmpegFrameArgs(
  inputPath: string,
  outputPath: string,
  timestampSeconds: number,
): string[] {
  return [
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
  ];
}

async function readFrame(
  outputPath: string,
  index: number,
  timestampSeconds: number,
): Promise<TicketVideoFrame> {
  const bytes = await readFrameBytes(outputPath);
  validateFrameBytes(bytes);
  return {
    index,
    timestampSeconds,
    contentType: 'image/png',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function readFrameBytes(outputPath: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(outputPath));
  } catch {
    throw new TicketVideoProcessingError(
      'Video frame extraction did not produce an output frame.',
    );
  }
}

function validateFrameBytes(bytes: Uint8Array): void {
  if (
    bytes.byteLength >= 8 &&
    bytes.byteLength <= MAX_VIDEO_FRAME_BYTES &&
    hasPngSignature(bytes)
  ) {
    return;
  }
  throw new TicketVideoProcessingError(
    'Derived video frame is invalid or exceeds the frame byte limit.',
  );
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

function hasPngSignature(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((value, index) => bytes[index] === value);
}

function roundedTimestamp(value: number): number {
  return Math.round(value * 1000) / 1000;
}
