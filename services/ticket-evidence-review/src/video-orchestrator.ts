import type {
  TicketAttachment,
  TicketContextBundle,
  TicketEvidenceClient,
  TicketVideoEvidence,
} from '@enthusia/integration-ticket-bot';
import {
  MAX_IMAGE_INFERENCES,
  MAX_IMAGE_LIMITATIONS,
  MAX_IMAGE_OBSERVATIONS,
  type ImageEvidenceAssessment,
  type RunImageEvidenceInput,
  type RunImageEvidenceResult,
} from '@enthusia/openai-gateway';
import {
  createDefaultTicketImageAssessmentRunner,
  type TicketImageAssessmentRunner,
} from './orchestrator.js';
import {
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_FRAMES,
  MAX_VIDEO_PIXELS,
  sampleTicketVideo,
  type SampleTicketVideoDeps,
  type TicketVideoSample,
} from './video-media.js';
import type {
  TicketVideoAssessmentRecord,
  TicketVideoFrameProvenance,
} from './types.js';

export const MAX_TICKET_VIDEO_ASSESSMENTS = 1;
const MAX_VIDEO_COLLECTION_ISSUES = 8;

const SUPPORTED_VIDEO_TYPES = new Set<TicketVideoEvidence['contentType']>([
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

export type TicketVideoCollectionIssueReason =
  | 'unsupported_type'
  | 'declared_too_large'
  | 'fetch_failed'
  | 'processing_failed'
  | 'assessment_failed'
  | 'limit_exceeded';

export interface TicketVideoCollectionIssue {
  messageId: string;
  attachmentId: string;
  reason: TicketVideoCollectionIssueReason;
}

export interface TicketVideoCollectionResult {
  assessments: TicketVideoAssessmentRecord[];
  issues: TicketVideoCollectionIssue[];
  eligibleAttachmentCount: number;
  attemptedCount: number;
}

export interface CollectTicketVideoAssessmentsInput {
  ticket: TicketContextBundle;
  evidenceClient: Pick<TicketEvidenceClient, 'getVideoEvidence'>;
  traceId: string;
  maxVideos?: number;
  assessImage?: TicketImageAssessmentRunner;
  sampleVideo?: (
    evidence: TicketVideoEvidence,
    deps?: SampleTicketVideoDeps,
  ) => Promise<TicketVideoSample>;
}

interface VideoCandidate {
  messageId: string;
  attachment: TicketAttachment;
  contentType: TicketVideoEvidence['contentType'];
}

export interface VideoFrameObservation {
  frameIndex: number;
  timestampSeconds: number;
  result: RunImageEvidenceResult;
}

export async function collectTicketVideoAssessments(
  input: CollectTicketVideoAssessmentsInput,
): Promise<TicketVideoCollectionResult> {
  const maximum = boundedMaxVideos(input.maxVideos);
  const selection = selectVideoCandidates(input.ticket, maximum);
  const assessments: TicketVideoAssessmentRecord[] = [];
  const issues = [...selection.issues];
  let runner = input.assessImage;
  const sampler = input.sampleVideo ?? sampleTicketVideo;

  for (const candidate of selection.selected) {
    runner ??= createDefaultTicketImageAssessmentRunner();
    const outcome = await assessVideoCandidate(
      input,
      candidate,
      sampler,
      runner,
    );
    if ('record' in outcome) assessments.push(outcome.record);
    else issues.push(outcome.issue);
  }

  return {
    assessments,
    issues: issues.slice(0, MAX_VIDEO_COLLECTION_ISSUES),
    eligibleAttachmentCount: selection.eligibleCount,
    attemptedCount: selection.selected.length,
  };
}

function boundedMaxVideos(value: number | undefined): number {
  if (value === undefined) return MAX_TICKET_VIDEO_ASSESSMENTS;
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_TICKET_VIDEO_ASSESSMENTS);
}

function selectVideoCandidates(
  ticket: TicketContextBundle,
  maximum: number,
): {
  selected: VideoCandidate[];
  issues: TicketVideoCollectionIssue[];
  eligibleCount: number;
} {
  const candidates: VideoCandidate[] = [];
  const issues: TicketVideoCollectionIssue[] = [];

  for (const message of ticket.messages) {
    for (const attachment of message.attachments ?? []) {
      const candidate = videoCandidate(message.id, attachment);
      if ('candidate' in candidate) candidates.push(candidate.candidate);
      else if (candidate.issue !== null) issues.push(candidate.issue);
    }
  }

  const selected = candidates.slice(-maximum);
  for (const omitted of candidates.slice(
    0,
    Math.max(0, candidates.length - maximum),
  )) {
    issues.push(
      issue(omitted.messageId, omitted.attachment.id, 'limit_exceeded'),
    );
  }
  return {
    selected,
    issues,
    eligibleCount: candidates.length,
  };
}

function videoCandidate(
  messageId: string,
  attachment: TicketAttachment,
):
  | { candidate: VideoCandidate }
  | { issue: TicketVideoCollectionIssue | null } {
  const normalized = normalizedVideoType(attachment.contentType);
  if (normalized === null) {
    return {
      issue: isDeclaredVideoType(attachment.contentType)
        ? issue(messageId, attachment.id, 'unsupported_type')
        : null,
    };
  }
  if (attachment.size < 1 || attachment.size > 25 * 1024 * 1024) {
    return {
      issue: issue(messageId, attachment.id, 'declared_too_large'),
    };
  }
  return {
    candidate: {
      messageId,
      attachment,
      contentType: normalized,
    },
  };
}

async function assessVideoCandidate(
  input: CollectTicketVideoAssessmentsInput,
  candidate: VideoCandidate,
  sampler: NonNullable<CollectTicketVideoAssessmentsInput['sampleVideo']>,
  runner: TicketImageAssessmentRunner,
): Promise<
  | { record: TicketVideoAssessmentRecord }
  | { issue: TicketVideoCollectionIssue }
> {
  const evidence = await fetchVideoEvidence(
    input.evidenceClient,
    input.ticket,
    candidate,
  );
  if (evidence === null) return candidateFailure(candidate, 'fetch_failed');

  let sample: TicketVideoSample;
  try {
    sample = await sampler(evidence);
    validateSampleProvenance(evidence, sample);
  } catch {
    return candidateFailure(candidate, 'processing_failed');
  }

  let frameObservations: VideoFrameObservation[];
  try {
    frameObservations = await assessFrames(
      input,
      candidate,
      sample,
      runner,
    );
  } catch {
    return candidateFailure(candidate, 'assessment_failed');
  }

  return {
    record: aggregateVideoAssessment(
      input.ticket.ticket.id,
      candidate,
      evidence,
      sample,
      frameObservations,
    ),
  };
}

async function assessFrames(
  input: CollectTicketVideoAssessmentsInput,
  candidate: VideoCandidate,
  sample: TicketVideoSample,
  runner: TicketImageAssessmentRunner,
): Promise<VideoFrameObservation[]> {
  const observations: VideoFrameObservation[] = [];
  for (const frame of sample.frames) {
    const request = frameAssessmentRequest(input, candidate, sample, frame);
    const result = await runner(request);
    if (
      result.evidenceRef !== request.evidenceRef ||
      result.evidenceSha256.toLowerCase() !== frame.sha256.toLowerCase()
    ) {
      throw new Error('frame assessment provenance mismatch');
    }
    observations.push({
      frameIndex: frame.index,
      timestampSeconds: frame.timestampSeconds,
      result,
    });
  }
  return observations;
}

function frameAssessmentRequest(
  input: CollectTicketVideoAssessmentsInput,
  candidate: VideoCandidate,
  sample: TicketVideoSample,
  frame: TicketVideoSample['frames'][number],
): RunImageEvidenceInput {
  return {
    traceId: input.traceId,
    evidenceRef: frameEvidenceReference(
      input.ticket.ticket.id,
      candidate.messageId,
      candidate.attachment.id,
      frame.index,
      frame.timestampSeconds,
    ),
    image: {
      bytes: frame.bytes,
      contentType: 'image/png',
      sha256: frame.sha256,
    },
    context: {
      ticketCategory: input.ticket.ticket.category,
      userQuestion:
        `${input.ticket.ticket.subject} Video frame at ` +
        `${frame.timestampSeconds.toFixed(3)}s of ` +
        `${sample.metadata.durationSeconds.toFixed(3)}s.`,
    },
  };
}

function aggregateVideoAssessment(
  ticketId: string,
  candidate: VideoCandidate,
  evidence: TicketVideoEvidence,
  sample: TicketVideoSample,
  frames: VideoFrameObservation[],
): TicketVideoAssessmentRecord {
  const assessment = aggregateFrameAssessments(sample, frames);
  const frameHashes = new Map(
    sample.frames.map((frame) => [frame.index, frame.sha256]),
  );
  const provenance: TicketVideoFrameProvenance[] = frames.map((item) => ({
    index: item.frameIndex,
    timestampSeconds: item.timestampSeconds,
    evidenceRef: item.result.evidenceRef,
    sha256: frameHashes.get(item.frameIndex) ?? '',
  }));
  return {
    messageId: candidate.messageId,
    attachmentId: candidate.attachment.id,
    evidenceRef: videoEvidenceReference(
      ticketId,
      candidate.messageId,
      candidate.attachment.id,
    ),
    evidenceSha256: evidence.sha256,
    assessment,
    mediaKind: 'video',
    video: {
      contentType: evidence.contentType,
      durationSeconds: sample.metadata.durationSeconds,
      width: sample.metadata.width,
      height: sample.metadata.height,
      codec: sample.metadata.codec,
      format: sample.metadata.format,
      frames: provenance,
    },
  };
}

export function aggregateFrameAssessments(
  sample: TicketVideoSample,
  frames: VideoFrameObservation[],
): ImageEvidenceAssessment {
  const observations: ImageEvidenceAssessment['observations'] = [];
  const inferences: ImageEvidenceAssessment['inferences'] = [];
  const limitations: string[] = [sample.limitation];
  const indexMap = new Map<string, number>();
  const summaries: string[] = [];
  let needsMoreContext = false;

  for (const frame of frames) {
    summaries.push(
      `${frame.timestampSeconds.toFixed(3)}s: ${frame.result.assessment.summary}`,
    );
    needsMoreContext ||= frame.result.assessment.needsMoreContext;
    for (const limitation of frame.result.assessment.limitations) {
      pushUniqueBounded(
        limitations,
        limitation,
        MAX_IMAGE_LIMITATIONS,
      );
    }
    for (const [localIndex, observation] of
      frame.result.assessment.observations.entries()) {
      if (observations.length >= MAX_IMAGE_OBSERVATIONS) break;
      const globalIndex = observations.length;
      indexMap.set(
        frameObservationKey(frame.frameIndex, localIndex),
        globalIndex,
      );
      observations.push({
        ...observation,
        text: truncate(
          `[${frame.timestampSeconds.toFixed(3)}s] ${observation.text}`,
          400,
        ),
      });
    }
  }

  for (const frame of frames) {
    for (const inference of frame.result.assessment.inferences) {
      if (inferences.length >= MAX_IMAGE_INFERENCES) break;
      const mapped = inference.observationIndexes.map((localIndex) =>
        indexMap.get(frameObservationKey(frame.frameIndex, localIndex)),
      );
      if (mapped.some((index) => index === undefined)) continue;
      inferences.push({
        ...inference,
        text: truncate(
          `[${frame.timestampSeconds.toFixed(3)}s] ${inference.text}`,
          400,
        ),
        observationIndexes: mapped as number[],
      });
    }
  }

  return {
    summary: truncate(
      `Sampled video evidence: ${summaries.join(' | ')}`,
      600,
    ),
    observations,
    inferences,
    limitations,
    needsMoreContext,
  };
}

function validateSampleProvenance(
  evidence: TicketVideoEvidence,
  sample: TicketVideoSample,
): void {
  if (sample.videoSha256.toLowerCase() !== evidence.sha256.toLowerCase()) {
    throw new Error('sampled video provenance mismatch');
  }
  if (
    !Number.isFinite(sample.metadata.durationSeconds) ||
    sample.metadata.durationSeconds <= 0 ||
    sample.metadata.durationSeconds > MAX_VIDEO_DURATION_SECONDS ||
    !Number.isInteger(sample.metadata.width) ||
    !Number.isInteger(sample.metadata.height) ||
    sample.metadata.width < 1 ||
    sample.metadata.height < 1 ||
    sample.metadata.width > MAX_VIDEO_DIMENSION ||
    sample.metadata.height > MAX_VIDEO_DIMENSION ||
    sample.metadata.width * sample.metadata.height > MAX_VIDEO_PIXELS ||
    sample.frames.length < 1 ||
    sample.frames.length > MAX_VIDEO_FRAMES
  ) {
    throw new Error('sampled video metadata is outside bounded limits');
  }

  const indexes = new Set<number>();
  for (const frame of sample.frames) {
    if (
      indexes.has(frame.index) ||
      !Number.isInteger(frame.index) ||
      frame.index < 0 ||
      !Number.isFinite(frame.timestampSeconds) ||
      frame.timestampSeconds < 0 ||
      frame.timestampSeconds > sample.metadata.durationSeconds ||
      !/^[a-f0-9]{64}$/.test(frame.sha256.toLowerCase())
    ) {
      throw new Error('sampled frame provenance is invalid');
    }
    indexes.add(frame.index);
  }
}

async function fetchVideoEvidence(
  client: Pick<TicketEvidenceClient, 'getVideoEvidence'>,
  ticket: TicketContextBundle,
  candidate: VideoCandidate,
): Promise<TicketVideoEvidence | null> {
  try {
    const evidence = await client.getVideoEvidence(
      ticket.ticket.id,
      candidate.messageId,
      candidate.attachment.id,
    );
    return evidence.contentType === candidate.contentType ? evidence : null;
  } catch {
    return null;
  }
}

function candidateFailure(
  candidate: VideoCandidate,
  reason: TicketVideoCollectionIssueReason,
): { issue: TicketVideoCollectionIssue } {
  return {
    issue: issue(candidate.messageId, candidate.attachment.id, reason),
  };
}

function normalizedVideoType(
  value: string | undefined,
): TicketVideoEvidence['contentType'] | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized !== undefined &&
    SUPPORTED_VIDEO_TYPES.has(
      normalized as TicketVideoEvidence['contentType'],
    )
  ) {
    return normalized as TicketVideoEvidence['contentType'];
  }
  return null;
}

function isDeclaredVideoType(value: string | undefined): boolean {
  return value?.trim().toLowerCase().startsWith('video/') === true;
}

function videoEvidenceReference(
  ticketId: string,
  messageId: string,
  attachmentId: string,
): string {
  return `ticket:${ticketId}:message:${messageId}:attachment:${attachmentId}:video`;
}

function frameEvidenceReference(
  ticketId: string,
  messageId: string,
  attachmentId: string,
  index: number,
  timestampSeconds: number,
): string {
  return (
    videoEvidenceReference(ticketId, messageId, attachmentId) +
    `:frame:${index}@${timestampSeconds.toFixed(3)}s`
  );
}

function issue(
  messageId: string,
  attachmentId: string,
  reason: TicketVideoCollectionIssueReason,
): TicketVideoCollectionIssue {
  return { messageId, attachmentId, reason };
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
  if (
    value.length === 0 ||
    values.includes(value) ||
    values.length >= maximum
  ) {
    return;
  }
  values.push(truncate(value, 300));
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return value.slice(0, maximum - 1) + '…';
}
