import { describe, expect, it, vi } from 'vitest';
import type { GenerationResult } from '@enthusia/inference-adapter';
import type {
  TicketContextBundle,
} from '@enthusia/integration-ticket-bot';
import type {
  StaffModerationStateSnapshot,
} from '@enthusia/integration-staff-moderation';
import { Visibility } from '@enthusia/contracts';
import type {
  ApprovedFileReadResult,
  LiveSourceResult,
} from '@enthusia/integration-sftp';
import { TicketEvidenceReviewRuntime } from '../src/ticket-evidence-runtime.js';

const IMAGE_SHA =
  '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';
const EVIDENCE_REF = 'ticket:42:message:m1:attachment:1001';

function ticket(
  category = 'report',
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
      category,
      subject: 'Player report',
      status: 'open',
      priority: 'normal',
      owner: { id: 'reporter', kind: 'player' },
      assignees: [],
      createdAt: '2026-10-06T18:00:00.000Z',
      updatedAt: '2026-10-06T18:05:00.000Z',
      messageCount: 1,
      metadata,
    },
    messages: [{
      id: 'm1',
      ticketId: '42',
      author: { id: 'reporter', kind: 'player' },
      body: 'Evidence attached.',
      createdAt: '2026-10-06T18:01:00.000Z',
      attachments: [{
        id: '1001',
        name: 'evidence.png',
        contentType: 'image/png',
        size: 4,
        source: 'discord',
      }],
    }],
    participants: [{ id: 'reporter', kind: 'player' }],
    fetchedAt: '2026-10-06T18:06:00.000Z',
  };
}

function policyRead(): LiveSourceResult<ApprovedFileReadResult> {
  const result: ApprovedFileReadResult = {
    sourceId: 'enthusia-staff-reason-policies',
    kind: 'structured-config',
    visibility: Visibility.STAFF,
    content: [
      'version: "2026-10-06.1"',
      'defaults:',
      '  reportable: true',
      'reasons:',
      '  - id: spam.low-level',
      '    family: spam',
      '    display-name: Low-level chat spam',
      '    severity: 10',
    ].join('\n'),
    redactedFields: [],
    redactionCount: 0,
    provenance: {
      source: 'sftp-live',
      targetServer: {
        id: 'smp',
        displayName: 'SMP',
        environment: 'production',
      },
      file: {
        path: '/configured/approved/reason-policies.yml',
        fileName: 'reason-policies.yml',
        sha256: 'a'.repeat(64),
        version: 'sha256:' + 'a'.repeat(64),
        sizeBytes: 256,
        modifiedAt: '2026-10-06T18:00:00.000Z',
      },
      observedAt: '2026-10-06T18:06:00.000Z',
      freshness: {
        kind: 'live-sha256',
        version: 'sha256:' + 'a'.repeat(64),
      },
    },
  };
  return {
    ok: true,
    server: result.provenance.targetServer,
    observedAt: result.provenance.observedAt,
    result,
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
    activeSanctions: [{
      sanctionId: '223e4567-e89b-12d3-a456-426614174000',
      caseId: 'unrelated-old-case',
      type: 'MUTE',
      publicReason: 'Unrelated old issue',
      issuedAt: '2026-10-06T12:00:00.000Z',
    }],
    recentCases,
    fetchedAt: '2026-10-06T18:08:00.000Z',
  };
}

function policyCompletion(): GenerationResult {
  return {
    content: JSON.stringify({
      concerns: [{
        ruleId: 'spam.low-level',
        confidence: 0.91,
        evidenceRefs: [EVIDENCE_REF],
        summary: 'Repeated visible messages may match the spam rule.',
      }],
      needsMoreContext: false,
    }),
    finishReason: 'stop',
    usage: {
      promptTokens: 300,
      completionTokens: 80,
      totalTokens: 380,
    },
    model: 'qwen-test',
    latencyMs: 10,
    attempts: 1,
  };
}

function runtime(overrides: {
  ticket?: TicketContextBundle;
  policyOutput?: LiveSourceResult<ApprovedFileReadResult>;
  staff?: StaffModerationStateSnapshot | Error;
  evidenceError?: boolean;
} = {}) {
  const getTicketContext = vi.fn(async () => overrides.ticket ?? ticket());
  const requestAction = vi.fn(async (ticketId: string) => ({
    requestId: 'ar-1',
    ticketId,
    action: 'escalate' as const,
    status: 'accepted' as const,
    createdAt: '2026-10-06T18:09:00.000Z',
    updatedAt: '2026-10-06T18:09:00.000Z',
  }));
  const getImageEvidence = vi.fn(async () => {
    if (overrides.evidenceError) throw new Error('private evidence failure');
    return {
      ticketId: '42',
      messageId: 'm1',
      attachmentId: '1001',
      contentType: 'image/png',
      size: 4,
      sha256: IMAGE_SHA,
      bytes: new Uint8Array([1, 2, 3, 4]),
    };
  });
  const getState = vi.fn(async () => {
    if (overrides.staff instanceof Error) throw overrides.staff;
    return overrides.staff ?? staffSnapshot();
  });
  const readApprovedFile = vi.fn(async () =>
    overrides.policyOutput ?? policyRead());
  const complete = vi.fn(async () => policyCompletion());
  const assessImage = vi.fn(async (input) => ({
    assessment: {
      summary: 'Minecraft chat screenshot.',
      observations: [{
        category: 'visible_text' as const,
        text: 'The same visible chat line appears repeatedly.',
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
  }));

  const reviewer = new TicketEvidenceReviewRuntime({
    ticketClient: { getTicketContext, requestAction },
    evidenceClient: { getImageEvidence },
    staffClient: { getState },
    policyGateway: { readApprovedFile },
    policySource: {
      serverId: 'smp',
      sourceId: 'enthusia-staff-reason-policies',
    },
    inference: { complete },
    assessImage,
  });

  return {
    reviewer,
    getTicketContext,
    requestAction,
    getImageEvidence,
    getState,
    readApprovedFile,
    complete,
    assessImage,
  };
}

describe('TicketEvidenceReviewRuntime', () => {
  it('ignores non-report tickets before policy, evidence, Staff, or model work', async () => {
    const state = runtime({ ticket: ticket('support') });

    const result = await state.reviewer.review('42', 'trace-1');

    expect(result).toEqual({
      status: 'not_applicable',
      retryable: false,
      pipeline: null,
    });
    expect(state.readApprovedFile).not.toHaveBeenCalled();
    expect(state.getImageEvidence).not.toHaveBeenCalled();
    expect(state.getState).not.toHaveBeenCalled();
    expect(state.complete).not.toHaveBeenCalled();
  });

  it('ignores a text-only triggering message before policy or model work', async () => {
    const value = ticket();
    value.messages[0] = {
      ...value.messages[0]!,
      attachments: [],
    };
    const state = runtime({ ticket: value });

    const result = await state.reviewer.review('42', 'trace-text-only', 'm1');

    expect(result.status).toBe('not_applicable');
    expect(result.retryable).toBe(false);
    expect(state.readApprovedFile).not.toHaveBeenCalled();
    expect(state.getImageEvidence).not.toHaveBeenCalled();
    expect(state.getState).not.toHaveBeenCalled();
    expect(state.complete).not.toHaveBeenCalled();
  });

  it('stops on a missing structured report target before paid/model work', async () => {
    const state = runtime({ ticket: ticket('report', {}) });

    const result = await state.reviewer.review('42', 'trace-2');

    expect(result.status).toBe('needs_target');
    expect(result.retryable).toBe(false);
    expect(state.readApprovedFile).not.toHaveBeenCalled();
    expect(state.getImageEvidence).not.toHaveBeenCalled();
    expect(state.getState).not.toHaveBeenCalled();
  });

  it('treats current policy source failure as retryable infrastructure failure', async () => {
    const unavailable: LiveSourceResult<ApprovedFileReadResult> = {
      ok: false,
      server: { id: 'smp', displayName: 'SMP', environment: 'production' },
      observedAt: '2026-10-06T18:06:00.000Z',
      error: {
        code: 'UNREACHABLE',
        message: 'sanitized',
        retryable: true,
      },
    };
    const state = runtime({ policyOutput: unavailable });

    const result = await state.reviewer.review('42', 'trace-3');

    expect(result.status).toBe('policy_source_unavailable');
    expect(result.retryable).toBe(true);
    expect(state.getImageEvidence).not.toHaveBeenCalled();
    expect(state.getState).not.toHaveBeenCalled();
  });

  it('treats image transport failure as retryable instead of blaming missing evidence', async () => {
    const state = runtime({ evidenceError: true });

    const result = await state.reviewer.review('42', 'trace-4');

    expect(result.status).toBe('evidence_runtime_unavailable');
    expect(result.retryable).toBe(true);
    expect(state.getState).not.toHaveBeenCalled();
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('suppresses escalation for a fresh same-rule authoritative action', async () => {
    const state = runtime({
      staff: staffSnapshot([{
        caseId: 'same-rule-case',
        exactReasonId: 'spam.low-level',
        sanctionFamily: 'spam',
        state: 'CLOSED',
        publicReason: 'Spam',
        issuedAt: '2026-10-06T18:07:00.000Z',
        hasActiveSanctions: true,
        configurationVersion: '2026-10-06.1',
      }]),
    });

    const result = await state.reviewer.review('42', 'trace-5');

    expect(result.status).toBe('already_actioned');
    expect(result.retryable).toBe(false);
    expect(state.getState).toHaveBeenCalledTimes(1);
    expect(state.requestAction).not.toHaveBeenCalled();
  });

  it('does not suppress a new report because of an unrelated active sanction', async () => {
    const state = runtime({ staff: staffSnapshot() });

    const result = await state.reviewer.review('42', 'trace-6', 'm1');

    expect(result.status).toBe('staff_escalation_submitted');
    expect(result.retryable).toBe(false);
    expect(state.getState).toHaveBeenCalledTimes(1);
    expect(state.requestAction).toHaveBeenCalledTimes(1);
  });

  it('holds a valid staff review when the fresh Staff state read fails', async () => {
    const state = runtime({
      staff: new Error('private staff transport detail'),
    });

    const result = await state.reviewer.review('42', 'trace-7');

    expect(result.status).toBe('moderation_state_unavailable');
    expect(result.retryable).toBe(true);
    expect(result.pipeline?.review?.disposition).toBe('staff_review');
    expect(state.requestAction).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private staff transport detail');
  });
});
