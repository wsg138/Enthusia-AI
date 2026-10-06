import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import type { StaffModerationStateSnapshot } from '@enthusia/integration-staff-moderation';
import type {
  ApprovedFileReadResult,
  LiveServerSourceGateway,
  LiveSourceResult,
} from '@enthusia/integration-sftp';
import {
  LivePolicyCatalogUnavailableError,
  loadCurrentPolicyCatalog,
} from '../src/live-policy.js';
import {
  staffSnapshotToModerationState,
  unavailableModerationState,
} from '../src/staff-state.js';
import type { EvidencePolicyConcern } from '../src/types.js';

const TARGET = 'Bad_Player';

function snapshot(
  cases: StaffModerationStateSnapshot['recentCases'],
): StaffModerationStateSnapshot {
  return {
    service: 'enthusia-staff',
    api: 'ai-moderation-state',
    contractVersion: 'v1',
    target: {
      requested: TARGET,
      playerId: '123e4567-e89b-12d3-a456-426614174000',
      username: TARGET,
    },
    activeSanctions: [{
      sanctionId: '223e4567-e89b-12d3-a456-426614174000',
      caseId: 'case-old',
      type: 'MUTE',
      publicReason: 'Unrelated old spam',
      issuedAt: '2026-10-06T12:00:00.000Z',
      expiresAt: '2026-10-07T12:00:00.000Z',
    }],
    recentCases: cases,
    fetchedAt: '2026-10-06T18:30:00.000Z',
  };
}

function concern(code = 'exploit.major-abuse'): EvidencePolicyConcern {
  return {
    code,
    label: 'Major exploit abuse',
    severity: 'high',
    confidence: 0.92,
    evidenceRefs: ['ticket:42:message:m1:attachment:a1'],
    summary: 'Verified evidence may match the exploit rule.',
  };
}

function caseRecord(
  exactReasonId: string,
  state: string,
  hasActiveSanctions = false,
): StaffModerationStateSnapshot['recentCases'][number] {
  return {
    caseId: 'case-current',
    exactReasonId,
    sanctionFamily: 'exploit',
    state,
    publicReason: 'Exploit abuse',
    issuedAt: '2026-10-06T18:00:00.000Z',
    hasActiveSanctions,
    configurationVersion: '2026-10-06.1',
  };
}

function policyRead(
  overrides: Partial<ApprovedFileReadResult> = {},
): LiveSourceResult<ApprovedFileReadResult> {
  const result: ApprovedFileReadResult = {
    sourceId: 'enthusia-staff-reason-policies',
    kind: 'structured-config',
    visibility: Visibility.STAFF,
    content: [
      'version: "2026-10-06.1"',
      'defaults:',
      '  reportable: true',
      'reasons:',
      '  - id: exploit.major-abuse',
      '    family: exploit',
      '    display-name: Major exploit abuse',
      '    severity: 85',
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
        path: '/srv/smp/plugins/EnthusiaStaff/reason-policies.yml',
        fileName: 'reason-policies.yml',
        sha256: 'a'.repeat(64),
        version: 'sha256:' + 'a'.repeat(64),
        sizeBytes: 256,
        modifiedAt: '2026-10-06T18:20:00.000Z',
      },
      observedAt: '2026-10-06T18:30:00.000Z',
      freshness: {
        kind: 'live-sha256',
        version: 'sha256:' + 'a'.repeat(64),
      },
    },
    ...overrides,
  };
  return {
    ok: true,
    server: result.provenance.targetServer,
    observedAt: result.provenance.observedAt,
    result,
  };
}

function gateway(
  output: LiveSourceResult<ApprovedFileReadResult>,
): Pick<LiveServerSourceGateway, 'readApprovedFile'> {
  return {
    async readApprovedFile() {
      return output;
    },
  };
}

describe('staffSnapshotToModerationState', () => {
  it('marks a same-rule open case as an existing review', () => {
    const state = staffSnapshotToModerationState(
      snapshot([caseRecord('exploit.major-abuse', 'OPEN')]),
      [concern()],
    );
    expect(state.duplicateStatus).toBe('review_open');
    expect(state.activeSanctions).toEqual([
      {
        id: '223e4567-e89b-12d3-a456-426614174000',
        type: 'MUTE',
        status: 'ACTIVE',
        reason: 'Unrelated old spam',
      },
    ]);
  });

  it('marks same-rule closed or active-sanction cases as actioned', () => {
    expect(staffSnapshotToModerationState(
      snapshot([caseRecord('exploit.major-abuse', 'CLOSED')]),
      [concern()],
    ).duplicateStatus).toBe('actioned');

    expect(staffSnapshotToModerationState(
      snapshot([caseRecord('exploit.major-abuse', 'OPEN', true)]),
      [concern()],
    ).duplicateStatus).toBe('actioned');
  });

  it('does not suppress a new report for unrelated or overturned cases', () => {
    expect(staffSnapshotToModerationState(
      snapshot([caseRecord('spam.low-level', 'CLOSED', true)]),
      [concern()],
    ).duplicateStatus).toBe('none');

    expect(staffSnapshotToModerationState(
      snapshot([caseRecord('exploit.major-abuse', 'FULLY_OVERTURNED')]),
      [concern()],
    ).duplicateStatus).toBe('none');
  });

  it('does not infer duplicate state before verified policy concerns exist', () => {
    expect(staffSnapshotToModerationState(
      snapshot([caseRecord('exploit.major-abuse', 'CLOSED', true)]),
    ).duplicateStatus).toBe('none');
  });

  it('builds an explicit unavailable state without guessing', () => {
    expect(unavailableModerationState(TARGET)).toEqual({
      availability: 'unavailable',
      target: TARGET,
      duplicateStatus: 'none',
      activeSanctions: [],
    });
  });
});

describe('loadCurrentPolicyCatalog', () => {
  const source = {
    serverId: 'smp',
    sourceId: 'enthusia-staff-reason-policies',
  };

  it('accepts a zero-redaction approved live file with SHA provenance', async () => {
    const catalog = await loadCurrentPolicyCatalog(
      gateway(policyRead()),
      source,
    );
    expect(catalog.policyVersion).toBe('2026-10-06.1');
    expect(catalog.provenance).toEqual({
      sourceId: 'enthusia-staff-reason-policies',
      fileVersion: 'sha256:' + 'a'.repeat(64),
      observedAt: '2026-10-06T18:30:00.000Z',
      sourceStatus: 'CURRENT',
    });
    expect(catalog.rules[0]?.id).toBe('exploit.major-abuse');
  });

  it('rejects redacted or mismatched approved sources', async () => {
    await expect(loadCurrentPolicyCatalog(
      gateway(policyRead({
        redactionCount: 1,
        redactedFields: ['secret'],
      })),
      source,
    )).rejects.toThrow(LivePolicyCatalogUnavailableError);

    await expect(loadCurrentPolicyCatalog(
      gateway(policyRead({ sourceId: 'other-source' })),
      source,
    )).rejects.toThrow(/identity did not match/);
  });

  it('fails closed when the live source is unavailable', async () => {
    const unavailable: LiveSourceResult<ApprovedFileReadResult> = {
      ok: false,
      server: {
        id: 'smp',
        displayName: 'SMP',
        environment: 'production',
      },
      observedAt: '2026-10-06T18:30:00.000Z',
      error: {
        code: 'UNREACHABLE',
        message: 'sanitized source failure',
        retryable: true,
      },
    };
    await expect(loadCurrentPolicyCatalog(
      gateway(unavailable),
      source,
    )).rejects.toThrow('Current moderation policy source is unavailable.');
  });
});
