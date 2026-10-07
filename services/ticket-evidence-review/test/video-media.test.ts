import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { TicketVideoEvidence } from '@enthusia/integration-ticket-bot';
import {
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_FRAMES,
  TicketVideoProcessingError,
  parseVideoMetadata,
  planVideoFrameTimestamps,
  sampleTicketVideo,
  type MediaCommandRunner,
} from '../src/video-media.js';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);

function videoEvidence(
  bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
  contentType: TicketVideoEvidence['contentType'] = 'video/mp4',
): TicketVideoEvidence {
  return {
    ticketId: 'T-42',
    messageId: '100000000000000010',
    attachmentId: '100000000000000011',
    contentType,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

function probeJson(overrides: {
  duration?: unknown;
  width?: unknown;
  height?: unknown;
  codec?: unknown;
  format?: unknown;
} = {}): string {
  return JSON.stringify({
    streams: [{
      codec_name: overrides.codec ?? 'h264',
      width: overrides.width ?? 1280,
      height: overrides.height ?? 720,
      duration: overrides.duration ?? '10.0',
    }],
    format: {
      duration: overrides.duration ?? '10.0',
      format_name: overrides.format ?? 'mov,mp4,m4a,3gp,3g2,mj2',
    },
  });
}

function fakeRunner(
  options: {
    probe?: string;
    frame?: Uint8Array;
    onRun?: (command: string, args: string[], timeoutMs: number) => void;
  } = {},
): MediaCommandRunner {
  return {
    async run(command, args, runOptions) {
      options.onRun?.(command, args, runOptions.timeoutMs);
      if (command.includes('ffprobe')) {
        return { stdout: options.probe ?? probeJson() };
      }
      const output = args.at(-1);
      if (output === undefined) throw new Error('missing output path');
      await writeFile(output, options.frame ?? PNG);
      return { stdout: '' };
    },
  };
}

describe('video frame timestamp planning', () => {
  it('samples short videos deterministically from beginning to end', () => {
    expect(planVideoFrameTimestamps(0.5)).toEqual([0]);
    expect(planVideoFrameTimestamps(2.2)).toEqual([0, 1.075, 2.15]);
  });

  it('caps long valid videos at the hard frame count', () => {
    const timestamps = planVideoFrameTimestamps(
      MAX_VIDEO_DURATION_SECONDS,
      MAX_VIDEO_FRAMES,
    );
    expect(timestamps).toHaveLength(MAX_VIDEO_FRAMES);
    expect(timestamps[0]).toBe(0);
    expect(timestamps.at(-1)).toBe(119.95);
  });

  it('rejects missing, non-positive, and over-limit durations', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 120.001]) {
      expect(() => planVideoFrameTimestamps(value)).toThrow(
        TicketVideoProcessingError,
      );
    }
  });
});

describe('video metadata validation', () => {
  it('accepts bounded MP4 metadata', () => {
    expect(parseVideoMetadata(probeJson(), 'video/mp4')).toEqual({
      durationSeconds: 10,
      width: 1280,
      height: 720,
      codec: 'h264',
      format: 'mov,mp4,m4a,3gp,3g2,mj2',
    });
  });

  it('rejects MIME/container mismatch', () => {
    expect(() =>
      parseVideoMetadata(
        probeJson({ format: 'matroska,webm' }),
        'video/mp4',
      ),
    ).toThrow(/container/);
  });

  it('rejects unsupported codecs', () => {
    expect(() =>
      parseVideoMetadata(probeJson({ codec: 'mpeg2video' }), 'video/mp4'),
    ).toThrow(/codec/);
  });

  it('rejects oversized dimensions', () => {
    expect(() =>
      parseVideoMetadata(
        probeJson({ width: 3840, height: 2160 }),
        'video/mp4',
      ),
    ).toThrow(/dimensions/);
  });

  it('rejects unknown or excessive duration', () => {
    expect(() =>
      parseVideoMetadata(probeJson({ duration: 'N/A' }), 'video/mp4'),
    ).toThrow(/duration/);
    expect(() =>
      parseVideoMetadata(probeJson({ duration: '121' }), 'video/mp4'),
    ).toThrow(/duration/);
  });
});

describe('bounded ticket video sampling', () => {
  it('extracts deterministic PNG frames with derived hashes', async () => {
    const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
    const sample = await sampleTicketVideo(videoEvidence(), {
      runner: fakeRunner({
        onRun(command, args, timeoutMs) {
          calls.push({ command, args: [...args], timeoutMs });
        },
      }),
      now: () => 1_000,
    });

    expect(sample.videoSha256).toBe(videoEvidence().sha256);
    expect(sample.frames).toHaveLength(MAX_VIDEO_FRAMES);
    expect(sample.frames[0]).toMatchObject({
      index: 0,
      timestampSeconds: 0,
      contentType: 'image/png',
    });
    expect(sample.frames[0]?.sha256).toBe(
      createHash('sha256').update(PNG).digest('hex'),
    );
    expect(sample.limitation).toContain('events between sampled frames');

    expect(calls[0]?.command).toBe('ffprobe');
    expect(calls.slice(1).every((call) => call.command === 'ffmpeg')).toBe(true);
    expect(
      calls.slice(1).every((call) =>
        call.args.includes('-nostdin') &&
        call.args.includes('-threads') &&
        call.args.includes('1')),
    ).toBe(true);
  });

  it('fails before decode when source provenance hash is wrong', async () => {
    const evidence = videoEvidence();
    evidence.sha256 = 'a'.repeat(64);
    await expect(
      sampleTicketVideo(evidence, { runner: fakeRunner() }),
    ).rejects.toThrow(/provenance hash/);
  });

  it('fails closed when derived frame output is not a PNG', async () => {
    await expect(
      sampleTicketVideo(videoEvidence(), {
        runner: fakeRunner({ frame: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }),
      }),
    ).rejects.toThrow(/Derived video frame/);
  });

  it('enforces the total processing deadline across commands', async () => {
    const times = [0, 0, 30_001];
    let last = 30_001;
    await expect(
      sampleTicketVideo(videoEvidence(), {
        runner: fakeRunner(),
        now: () => {
          const value = times.shift();
          if (value !== undefined) last = value;
          return last;
        },
      }),
    ).rejects.toThrow(/total time limit/);
  });

  it('fails closed when ffprobe cannot inspect the video', async () => {
    const runner: MediaCommandRunner = {
      async run() {
        throw new Error('decoder unavailable');
      },
    };
    await expect(
      sampleTicketVideo(videoEvidence(), { runner }),
    ).rejects.toThrow(/inspection failed/);
  });
});
