import { describe, expect, it, vi } from 'vitest';
import type {
  TicketContextBundle,
} from '@enthusia/integration-ticket-bot';
import type {
  StaffModerationStateSnapshot,
} from '@enthusia/integration-staff-moderation';
import type {
  InferenceClient,
} from '@enthusia/inference-adapter';
import type {
  LiveServerSourceGateway,
} from '@enthusia/integration-sftp';
import {
  LivePolicyCatalogReader,
  TicketEvidenceReviewService,
} from '../src/ticket-evidence-review.js';

const IMAGE_SHA =
  '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';

const POLICY = [
  'version: "2026-10-06.1"',
  'defaults:',
  '  reportable: true',
  'reasons:',
  '  - id: chat.harassment',
  '    family: chat',
  '    display-name: Harassment',
  '    severity: 70',
].join('\n');

function ticket(
  metadata: Record<string, unknown> = {
    reportTarget: {
      kind: 'minecraft_username',
      value: 'Bad_Player',
    },
  },
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
      updatedAt: '2026-10-06T12:10:00.000Z',
      messageCount: 1,
      metadata,
    },
    messages: [{
      id: 'm1',
      ticketId: '42',
      author: { id: 'reporter', kind: 'player' },
      body: 'Screenshot attached.',
      createdAt: '2026-10-06T12:01:00.000Z',
      attachments: [{
        id: '1001',
        name: 'evidence.png',
        contentType: 'image/png',
        size: 4,
        source: 'discord',
      }],
    }],
    participants: [{ id: 'reporter', kind: 'player' }],
    fetchedAt: '2026-10-06T12:11:00.000Z',
  };
}

function staffSnapshot(
  recentCases: StaffModerationStateSnapshot['recentCases'] = [],
): StaffModerationStateSnapshot {
  return {
    service: 'enthusia-staff',
    api: 'ai-moderation-state',
    contractVersion: 'v1',
    target: {
      requested: 'Bad_Player',
      playerId: '123e4567-e89b-12d3-a456-426614174000',
      username: 'Bad_Player',
    },
    activeSanctions: [],
    recentCases,
    fetchedAt: '2026-10-06T12:12:00.000Z',
  };
}

function fakeInference(): Pick<InferenceClient, 'complete'> {
  return {
    async complete() {
      return {
        content: JSON.stringify({
          concerns: [{
            ruleId: 'chat.harassment',
            confidence: 0.92,
            evidenceRefs: ['ticket:42:message:m1:attachment:1001'],
            summary: 'Visible chat text supports staff review.',
          }],
          needsMoreContext: false,
        }),
        model: 'qwen-test',
        finishReason: 'stop',
        usage: {
          promptTokens: 200,
          completionTokens: 50,
          totalTokens: 250,
        },
        latencyMs: 10,
        attempts: 1,
      };
    },
  } as Pick<InferenceClient, 'complete'>;
}

function policyReader() {
  return {
    async read() {
      return {
        policyVersion: '2026-10-06.1',
        provenance: {
          sourceId: 'enthusia-staff-reason-policies',
          fileVersion: 'sha256:' + 'a'.repeat(64),
          observedAt: '2026-10-06T12:11:00.000Z',
          sourceStatus: 'CURRENT' as const,
        },
        rules: [{
          id: 'chat.harassment',
          family: 'chat',
          label: 'Harassment',
          severity: 70,
          severityBand: 'high' as const,
          examples: [],
        }],
      };
    },
  };
}

function imageRunner() {
  return async (input: {
    evidenceRef: string;
    image: { sha256: string };
  }) => ({
    assessment: {
      summary: 'Minecraft chat screenshot.',
      observations: [{
        category: 'visible_text' as const,
        text: 'A visible chat message contains targeted harassment.',
        confidence: 0.97,
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
  });
}

function service(overrides: {
  ticket?: TicketContextBundle;
  moderation?: StaffModerationStateSnapshot | Error;
  inference?: Pick<InferenceClient, 'complete'>;
} = {}) {
  const requestAction = vi.fn(async (ticketId: string) => ({
    requestId: 'ar-1',
    ticketId,
    action: 'escalate' as const,
    status: 'accepted' as const,
    createdAt: '2026-10-06T12:13:00.000Z',
    updatedAt: '2026-10-06T12:13:00.000Z',
  }));
  const getState = vi.fn(async () => {
    if (overrides.moderation instanceof Error) throw overrides.moderation;
    return overrides.moderation ?? staffSnapshot();
  });
  const getTicketContext = vi.fn(async () => overrides.ticket ?? ticket());
  const reviewService = new TicketEvidenceReviewService({
    ticketClient: {
      getTicketContext,
      requestAction,
    },
    evidenceClient: {
      async getImageEvidence(ticketId, messageId, attachmentId) {
        return {
          ticketId,
          messageId,
          attachmentId,
          contentType: 'image/png',
          size: 4,
          sha256: IMAGE_SHA,
          bytes: new Uint8Array([1, 2, 3, 4]),
        };
      },
    },
    policyReader: policyReader(),
    moderationClient: { getState },
    inference: overrides.inference ?? fakeInference(),
    assessImage: imageRunner(),
  });
  return { reviewService, requestAction, getState, getTicketContext };
}

describe('LivePolicyCatalogReader', () => {
  it('turns a live approved file into a CURRENT hashed policy catalog', async () => {
    const gateway = {
      async readApprovedFile() {
        return {
          ok: true as const,
          server: { id: 'smp', displayName: 'SMP', environment: 'production' },
          observedAt: '2026-10-06T12:11:00.000Z',
          result: {
            sourceId: 'enthusia-staff-reason-policies',
            kind: 'config' as const,
            visibility: 'STAFF',
            content: POLICY,
            redactedFields: [],
            redactionCount: 0,
            provenance: {
              source: 'sftp-live' as const,
              targetServer: {
                id: 'smp',
                displayName: 'SMP',
                environment: 'production',
              },
              file: {
                path: '/approved/reason-policies.yml',
                fileName: 'reason-policies.yml',
                sha256: 'b'.repeat(64),
                version: 'sha256:' + 'b'.repeat(64),
                sizeBytes: POLICY.length,
                modifiedAt: '2026-10-06T12:10:00.000Z',
              },
              observedAt: '2026-10-06T12:11:00.000Z',
              freshness: {
                kind: 'live-sha256' as const,
                version: 'sha256:' + 'b'.repeat(64),
              },
            },
          },
        };
      },
    } as unknown as Pick<LiveServerSourceGateway, 'readApprovedFile'>;

    const reader = new LivePolicyCatalogReader({
      gateway,
      serverId: 'smp',
      sourceId: 'enthusia-staff-reason-policies',
    });
    const result = await reader.read();
    expect(result.policyVersion).toBe('2026-10-06.1');
    expect(result.provenance).toMatchObject({
      sourceId: 'enthusia-staff-reason-policies',
      fileVersion: 'sha256:' + 'b'.repeat(64),
      sourceStatus: 'CURRENT',
    });
  });

  it('rejects redacted policy text instead of classifying from partial policy', async () => {
    const gateway = {
      async readApprovedFile() {
        return {
          ok: true as const,
          result: {
            content: POLICY,
            redactionCount: 1,
          },
        };
      },
    } as unknown as Pick<LiveServerSourceGateway, 'readApprovedFile'>;

    const reader = new LivePolicyCatalogReader({
      gateway,
      serverId: 'smp',
      sourceId: 'enthusia-staff-reason-policies',
    });
    await expect(reader.read()).rejects.toThrow(/could not be used safely/);
  });
});

describe('TicketEvidenceReviewService', () => {
  it('short-circuits a missing report target before policy, Staff, or image work', async () => {
    const state = service({ ticket: ticket({}) });
    const result = await state.reviewService.review(
      { ticketId: '42' },
      'trace-missing-target',
    );

    expect(result.status).toBe('needs_target');
    expect(result.disposition).toBe('needs_more_evidence');
    expect(state.getState).not.toHaveBeenCalled();
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('does not query Staff state when verified policy finds no concern', async () => {
    const state = service({
      inference: {
        async complete() {
          return {
            content: JSON.stringify({
              concerns: [],
              needsMoreContext: false,
            }),
            model: 'qwen-test',
            finishReason: 'stop',
            usage: {
              promptTokens: 200,
              completionTokens: 20,
              totalTokens: 220,
            },
            latencyMs: 10,
            attempts: 1,
          };
        },
      } as Pick<InferenceClient, 'complete'>,
    });

    const result = await state.reviewService.review(
      { ticketId: '42' },
      'trace-benign',
    );

    expect(result.status).toBe('no_escalation');
    expect(result.disposition).toBe('no_escalation');
    expect(state.getState).not.toHaveBeenCalled();
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('suppresses escalation for a matching Staff case created after this ticket', async () => {
    const state = service({
      moderation: staffSnapshot([{
        caseId: 'case-new',
        exactReasonId: 'chat.harassment',
        sanctionFamily: 'chat',
        state: 'CLOSED',
        publicReason: 'Harassment',
        issuedAt: '2026-10-06T12:05:00.000Z',
        hasActiveSanctions: false,
        configurationVersion: '2026-10-06.1',
      }]),
    });
    const result = await state.reviewService.review(
      { ticketId: '42' },
      'trace-duplicate',
    );

    expect(result.status).toBe('already_actioned');
    expect(result.moderation).toEqual({
      verified: true,
      duplicateStatus: 'actioned',
    });
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('does not suppress escalation for an unrelated Staff case', async () => {
    const state = service({
      moderation: staffSnapshot([{
        caseId: 'case-other',
        exactReasonId: 'spam.low-level',
        sanctionFamily: 'spam',
        state: 'CLOSED',
        publicReason: 'Spam',
        issuedAt: '2026-10-06T12:05:00.000Z',
        hasActiveSanctions: true,
        configurationVersion: '2026-10-06.1',
      }]),
    });
    const result = await state.reviewService.review(
      { ticketId: '42' },
      'trace-escalate',
    );

    expect(result.status).toBe('staff_escalation_submitted');
    expect(result.disposition).toBe('staff_review');
    expect(result.delivery?.status).toBe('accepted');
    expect(state.requestAction).toHaveBeenCalledTimes(1);
  });

  it('holds a strong review when authoritative Staff state cannot be read', async () => {
    const state = service({
      moderation: new Error('private transport detail'),
    });
    const result = await state.reviewService.review(
      { ticketId: '42' },
      'trace-staff-down',
    );

    expect(result.status).toBe('moderation_state_unavailable');
    expect(result.disposition).toBe('staff_review');
    expect(result.moderation.verified).toBe(false);
    expect(state.requestAction).not.toHaveBeenCalled();
  });
});
