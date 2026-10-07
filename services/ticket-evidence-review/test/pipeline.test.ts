import { describe, expect, it, vi } from 'vitest';
import type {
  ActionRequestResult,
  TicketContextBundle,
} from '@enthusia/integration-ticket-bot';
import type {
  RunImageEvidenceInput,
  RunImageEvidenceResult,
} from '@enthusia/openai-gateway';
import {
  runTicketEvidencePipeline,
  type TicketEvidencePipelineInput,
} from '../src/pipeline.js';
import type { VerifiedPolicyCatalog } from '../src/policy-catalog.js';
import type {
  AuthoritativeModerationState,
  EvidencePolicyConcern,
} from '../src/types.js';
import type { TicketVideoSample } from '../src/video-media.js';

const IMAGE_SHA =
  '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';
const EVIDENCE_REF = 'ticket:42:message:m1:attachment:1001';

function ticket(
  metadata: Record<string, unknown> = {
    reportTarget: {
      kind: 'minecraft_username',
      value: 'Bad_Player',
    },
  },
  contentType = 'image/png',
): TicketContextBundle {
  return {
    ticket: {
      id: '42',
      category: 'report',
      subject: 'Player report',
      status: 'open',
      priority: 'normal',
      owner: { id: 'reporter', kind: 'player' },
      assignees: [],
      createdAt: '2026-10-06T12:00:00.000Z',
      updatedAt: '2026-10-06T12:05:00.000Z',
      messageCount: 1,
      metadata,
    },
    messages: [{
      id: 'm1',
      ticketId: '42',
      author: { id: 'reporter', kind: 'player' },
      body: 'Evidence attached.',
      createdAt: '2026-10-06T12:01:00.000Z',
      attachments: [{
        id: '1001',
        name: contentType.startsWith('image/') ? 'evidence.png' : 'notes.txt',
        contentType,
        size: 4,
        source: 'discord',
      }],
    }],
    participants: [{ id: 'reporter', kind: 'player' }],
    fetchedAt: '2026-10-06T12:06:00.000Z',
  };
}

function catalog(): VerifiedPolicyCatalog {
  return {
    policyVersion: '2026-10-06.1',
    provenance: {
      sourceId: 'enthusia-staff-reason-policies',
      fileVersion: 'sha256:' + 'a'.repeat(64),
      observedAt: '2026-10-06T12:06:00.000Z',
      sourceStatus: 'CURRENT',
    },
    rules: [{
      id: 'spam.low-level',
      family: 'spam',
      label: 'Low-level chat spam',
      severity: 10,
      severityBand: 'low',
      examples: [],
    }],
  };
}

function moderation(
  availability: AuthoritativeModerationState['availability'] = 'verified',
): AuthoritativeModerationState {
  return {
    availability,
    target: 'Bad_Player',
    duplicateStatus: 'none',
    activeSanctions: [],
    fetchedAt: '2026-10-06T12:06:00.000Z',
  };
}

function concern(): EvidencePolicyConcern {
  return {
    code: 'spam.low-level',
    label: 'Low-level chat spam',
    severity: 'low',
    confidence: 0.91,
    evidenceRefs: [EVIDENCE_REF],
    summary: 'Repeated visible chat lines support a spam concern.',
  };
}

function imageResult(
  input: RunImageEvidenceInput,
): RunImageEvidenceResult {
  return {
    assessment: {
      summary: 'Minecraft chat screenshot.',
      observations: [{
        category: 'visible_text',
        text: 'The same chat line appears repeatedly.',
        confidence: 0.96,
      }],
      inferences: [],
      limitations: [],
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
    estimatedCostUsd: 0.001,
  };
}

function videoSample(): TicketVideoSample {
  return {
    videoSha256: 'b'.repeat(64),
    metadata: {
      durationSeconds: 2,
      width: 1280,
      height: 720,
      codec: 'h264',
      format: 'mov,mp4,m4a,3gp,3g2,mj2',
    },
    frames: [
      {
        index: 0,
        timestampSeconds: 0,
        contentType: 'image/png',
        bytes: new Uint8Array([1]),
        sha256: 'c'.repeat(64),
      },
      {
        index: 1,
        timestampSeconds: 1.95,
        contentType: 'image/png',
        bytes: new Uint8Array([2]),
        sha256: 'd'.repeat(64),
      },
    ],
    limitation:
      'Video was sampled at 2 deterministic timestamps; events between sampled frames may not be visible.',
  };
}

function acceptedAction(ticketId: string): ActionRequestResult {
  return {
    requestId: 'ar-1',
    ticketId,
    action: 'escalate',
    status: 'accepted',
    createdAt: '2026-10-06T12:07:00.000Z',
    updatedAt: '2026-10-06T12:07:00.000Z',
  };
}

function input(overrides: Partial<TicketEvidencePipelineInput> = {}) {
  const getImageEvidence = vi.fn(async (
    ticketId: string,
    messageId: string,
    attachmentId: string,
  ) => ({
    ticketId,
    messageId,
    attachmentId,
    contentType: 'image/png',
    size: 4,
    sha256: IMAGE_SHA,
    bytes: new Uint8Array([1, 2, 3, 4]),
  }));
  const assess = vi.fn(async () => ({
    concerns: [concern()],
    needsMoreContext: false,
    model: 'qwen-test',
    usage: {
      promptTokens: 300,
      completionTokens: 80,
      totalTokens: 380,
    },
    policyVersion: '2026-10-06.1',
    policyFileVersion: 'sha256:' + 'a'.repeat(64),
  }));
  const requestAction = vi.fn(async (ticketId: string) =>
    acceptedAction(ticketId));

  const value: TicketEvidencePipelineInput = {
    ticket: ticket(),
    traceId: 'trace-pipeline-42',
    evidenceClient: { getImageEvidence },
    policyCatalog: catalog(),
    policyAssessor: { assess },
    moderationState: moderation(),
    ticketClient: { requestAction },
    assessImage: async (request) => imageResult(request),
    ...overrides,
  };
  return { value, getImageEvidence, assess, requestAction };
}

describe('runTicketEvidencePipeline', () => {
  it('runs the verified path and submits exactly one staff escalation request', async () => {
    const state = input();
    const result = await runTicketEvidencePipeline(state.value);

    expect(result.status).toBe('staff_escalation_submitted');
    expect(result.review?.disposition).toBe('staff_review');
    expect(result.delivery?.status).toBe('accepted');
    expect(result.collection.assessments).toHaveLength(1);
    expect(state.getImageEvidence).toHaveBeenCalledTimes(1);
    expect(state.assess).toHaveBeenCalledTimes(1);
    expect(state.requestAction).toHaveBeenCalledTimes(1);
  });

  it('routes bounded video evidence through the existing policy and staff-review path', async () => {
    const state = input({
      ticket: ticket(undefined, 'video/mp4'),
    });
    const getVideoEvidence = vi.fn(async (
      ticketId: string,
      messageId: string,
      attachmentId: string,
    ) => ({
      ticketId,
      messageId,
      attachmentId,
      contentType: 'video/mp4' as const,
      size: 8,
      sha256: 'b'.repeat(64),
      bytes: new Uint8Array([0, 0, 0, 1, 2, 3, 4, 5]),
    }));
    state.value.evidenceClient = {
      getImageEvidence: state.getImageEvidence,
      getVideoEvidence,
    };
    state.value.sampleVideo = async () => videoSample();
    state.value.policyAssessor = {
      assess: vi.fn(async (assessmentInput) => {
        const ref = assessmentInput.imageEvidence[0]?.evidenceRef;
        if (ref === undefined) throw new Error('missing visual evidence');
        return {
          concerns: [{
            ...concern(),
            evidenceRefs: [ref],
          }],
          needsMoreContext: false,
          model: 'qwen-test',
          usage: {
            promptTokens: 300,
            completionTokens: 80,
            totalTokens: 380,
          },
          policyVersion: '2026-10-06.1',
          policyFileVersion: 'sha256:' + 'a'.repeat(64),
        };
      }),
    };

    const result = await runTicketEvidencePipeline(state.value);

    expect(result.status).toBe('staff_escalation_submitted');
    expect(result.collection.videoAssessmentCount).toBe(1);
    expect(result.collection.imageAssessmentCount).toBe(0);
    expect(result.collection.assessments).toHaveLength(1);
    expect(result.collection.assessments[0]).toMatchObject({
      mediaKind: 'video',
      evidenceRef: 'ticket:42:message:m1:attachment:1001:video',
    });
    expect(getVideoEvidence).toHaveBeenCalledTimes(1);
    expect(state.getImageEvidence).not.toHaveBeenCalled();
    expect(state.requestAction).toHaveBeenCalledTimes(1);
  });

  it('short-circuits an existing Ticket Bot escalation before image or model work', async () => {
    const state = input({
      ticket: ticket({
        reportTarget: {
          kind: 'minecraft_username',
          value: 'Bad_Player',
        },
        recentActionRequests: [{
          requestId: 'ar-existing',
          action: 'escalate',
          status: 'accepted',
          createdAt: '2026-10-06T12:04:00.000Z',
          updatedAt: '2026-10-06T12:04:01.000Z',
        }],
      }),
    });

    const result = await runTicketEvidencePipeline(state.value);

    expect(result.status).toBe('already_actioned');
    expect(result.review?.disposition).toBe('already_actioned');
    expect(result.collection.attemptedCount).toBe(0);
    expect(state.getImageEvidence).not.toHaveBeenCalled();
    expect(state.assess).not.toHaveBeenCalled();
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('short-circuits a missing report target before any paid evidence work', async () => {
    const state = input({
      ticket: ticket({}),
      moderationState: {
        availability: 'unavailable',
        target: '',
        duplicateStatus: 'none',
        activeSanctions: [],
      },
    });

    const result = await runTicketEvidencePipeline(state.value);

    expect(result.status).toBe('needs_target');
    expect(result.review?.target).toBeNull();
    expect(state.getImageEvidence).not.toHaveBeenCalled();
    expect(state.assess).not.toHaveBeenCalled();
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('skips policy assessment when no supported image can be assessed', async () => {
    const state = input({ ticket: ticket(undefined, 'text/plain') });

    const result = await runTicketEvidencePipeline(state.value);

    expect(result.status).toBe('needs_more_evidence');
    expect(result.collection.assessments).toEqual([]);
    expect(result.collection.issues).toContainEqual({
      messageId: 'm1',
      attachmentId: '1001',
      reason: 'unsupported_type',
    });
    expect(state.getImageEvidence).not.toHaveBeenCalled();
    expect(state.assess).not.toHaveBeenCalled();
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('fails safe when local policy assessment is unavailable', async () => {
    const state = input();
    state.value.policyAssessor = {
      assess: vi.fn(async () => {
        throw new Error('private local inference failure detail');
      }),
    };

    const result = await runTicketEvidencePipeline(state.value);

    expect(result.status).toBe('policy_assessment_unavailable');
    expect(result.review).toBeNull();
    expect(result.delivery).toBeNull();
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('resolves authoritative moderation state after verified policy concerns exist', async () => {
    const state = input({
      moderationState: moderation('unavailable'),
    });
    const resolver = vi.fn(async () => moderation('verified'));
    state.value.moderationStateResolver = resolver;

    const result = await runTicketEvidencePipeline(state.value);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith({
      target: 'Bad_Player',
      concerns: [concern()],
    });
    expect(result.status).toBe('staff_escalation_submitted');
    expect(result.review?.moderationState.availability).toBe('verified');
    expect(state.requestAction).toHaveBeenCalledTimes(1);
  });

  it('fails closed when post-policy authoritative moderation resolution fails', async () => {
    const state = input({
      moderationState: moderation('unavailable'),
    });
    state.value.moderationStateResolver = vi.fn(async () => {
      throw new Error('private Staff API transport detail');
    });

    const result = await runTicketEvidencePipeline(state.value);

    expect(result.status).toBe('moderation_state_unavailable');
    expect(result.review?.disposition).toBe('staff_review');
    expect(result.review?.moderationState.availability).toBe('unavailable');
    expect(result.delivery).toBeNull();
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('holds a valid staff review when authoritative moderation state is unavailable', async () => {
    const state = input({
      moderationState: moderation('unavailable'),
    });

    const result = await runTicketEvidencePipeline(state.value);

    expect(result.status).toBe('moderation_state_unavailable');
    expect(result.review?.disposition).toBe('staff_review');
    expect(result.review?.shouldEscalate).toBe(true);
    expect(result.delivery).toBeNull();
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('does not require Staff state for a non-escalating policy result', async () => {
    const state = input({
      moderationState: moderation('unavailable'),
    });
    state.value.policyAssessor = {
      assess: vi.fn(async () => ({
        concerns: [],
        needsMoreContext: false,
        model: 'qwen-test',
        usage: {
          promptTokens: 300,
          completionTokens: 40,
          totalTokens: 340,
        },
        policyVersion: '2026-10-06.1',
        policyFileVersion: 'sha256:' + 'a'.repeat(64),
      })),
    };
    const resolver = vi.fn(async () => moderation('verified'));
    state.value.moderationStateResolver = resolver;

    const result = await runTicketEvidencePipeline(state.value);

    expect(result.status).toBe('no_escalation');
    expect(result.review?.disposition).toBe('no_escalation');
    expect(resolver).not.toHaveBeenCalled();
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('propagates policy ambiguity into a needs-more-evidence decision', async () => {
    const state = input();
    state.value.policyAssessor = {
      assess: vi.fn(async () => ({
        concerns: [concern()],
        needsMoreContext: true,
        model: 'qwen-test',
        usage: {
          promptTokens: 300,
          completionTokens: 80,
          totalTokens: 380,
        },
        policyVersion: '2026-10-06.1',
        policyFileVersion: 'sha256:' + 'a'.repeat(64),
      })),
    };

    const result = await runTicketEvidencePipeline(state.value);

    expect(result.status).toBe('needs_more_evidence');
    expect(result.review?.disposition).toBe('needs_more_evidence');
    expect(result.review?.shouldEscalate).toBe(false);
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('reports delivery failure without throwing or submitting a second request', async () => {
    const state = input();
    state.value.ticketClient = {
      requestAction: vi.fn(async () => {
        throw new Error('private Ticket Bot transport detail');
      }),
    };

    const result = await runTicketEvidencePipeline(state.value);

    expect(result.status).toBe('staff_escalation_failed');
    expect(result.review?.disposition).toBe('staff_review');
    expect(result.delivery).toBeNull();
  });
});
