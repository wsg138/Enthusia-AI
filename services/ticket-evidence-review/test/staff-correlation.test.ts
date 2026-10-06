import { describe, expect, it } from 'vitest';
import type { StaffModerationStateSnapshot } from '@enthusia/integration-staff-moderation';
import {
  correlateStaffModerationState,
  unavailableModerationState,
} from '../src/staff-correlation.js';
import type { EvidencePolicyConcern } from '../src/types.js';

function snapshot(
  recentCases: StaffModerationStateSnapshot['recentCases'],
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
      caseId: 'case-1',
      type: 'MUTE',
      publicReason: 'Old unrelated spam case',
      issuedAt: '2026-10-05T12:00:00.000Z',
      expiresAt: '2026-10-07T12:00:00.000Z',
    }],
    recentCases,
    fetchedAt: '2026-10-06T13:00:00.000Z',
  };
}

function concern(code = 'chat.harassment'): EvidencePolicyConcern {
  return {
    code,
    label: 'Harassment',
    severity: 'high',
    confidence: 0.9,
    evidenceRefs: ['ticket:42:message:m1:attachment:a1'],
    summary: 'Evidence supports review.',
  };
}

describe('correlateStaffModerationState', () => {
  it('marks a matching post-ticket closed case as already actioned', () => {
    const state = correlateStaffModerationState({
      snapshot: snapshot([{
        caseId: 'case-new',
        exactReasonId: 'chat.harassment',
        sanctionFamily: 'chat',
        state: 'CLOSED',
        publicReason: 'Harassment',
        issuedAt: '2026-10-06T12:30:00.000Z',
        hasActiveSanctions: false,
        configurationVersion: '2026-10-06.1',
      }]),
      target: 'Bad_Player',
      concerns: [concern()],
      incidentSince: '2026-10-06T12:00:00.000Z',
    });

    expect(state.duplicateStatus).toBe('actioned');
    expect(state.activeSanctions).toHaveLength(1);
  });

  it('marks a matching post-ticket open case as an existing review', () => {
    const state = correlateStaffModerationState({
      snapshot: snapshot([{
        caseId: 'case-new',
        exactReasonId: 'chat.harassment',
        sanctionFamily: 'chat',
        state: 'OPEN',
        publicReason: 'Harassment',
        issuedAt: '2026-10-06T12:30:00.000Z',
        hasActiveSanctions: false,
        configurationVersion: '2026-10-06.1',
      }]),
      target: 'Bad_Player',
      concerns: [concern()],
      incidentSince: '2026-10-06T12:00:00.000Z',
    });

    expect(state.duplicateStatus).toBe('review_open');
  });

  it('does not suppress for an older matching case or a newer unrelated case', () => {
    const state = correlateStaffModerationState({
      snapshot: snapshot([
        {
          caseId: 'case-old',
          exactReasonId: 'chat.harassment',
          sanctionFamily: 'chat',
          state: 'CLOSED',
          publicReason: 'Old harassment',
          issuedAt: '2026-10-05T12:00:00.000Z',
          hasActiveSanctions: true,
          configurationVersion: '2026-10-05.1',
        },
        {
          caseId: 'case-unrelated',
          exactReasonId: 'spam.low-level',
          sanctionFamily: 'spam',
          state: 'CLOSED',
          publicReason: 'Spam',
          issuedAt: '2026-10-06T12:45:00.000Z',
          hasActiveSanctions: true,
          configurationVersion: '2026-10-06.1',
        },
      ]),
      target: 'Bad_Player',
      concerns: [concern()],
      incidentSince: '2026-10-06T12:00:00.000Z',
    });

    expect(state.duplicateStatus).toBe('none');
  });

  it('never suppresses for a fully overturned matching case', () => {
    const state = correlateStaffModerationState({
      snapshot: snapshot([{
        caseId: 'case-overturned',
        exactReasonId: 'chat.harassment',
        sanctionFamily: 'chat',
        state: 'FULLY_OVERTURNED',
        publicReason: 'Harassment',
        issuedAt: '2026-10-06T12:30:00.000Z',
        hasActiveSanctions: false,
        configurationVersion: '2026-10-06.1',
      }]),
      target: 'Bad_Player',
      concerns: [concern()],
      incidentSince: '2026-10-06T12:00:00.000Z',
    });

    expect(state.duplicateStatus).toBe('none');
  });

  it('rejects a moderation snapshot for a different requested target', () => {
    const wrong = snapshot([]);
    wrong.target.requested = 'SomeoneElse';
    expect(() =>
      correlateStaffModerationState({
        snapshot: wrong,
        target: 'Bad_Player',
        concerns: [concern()],
        incidentSince: '2026-10-06T12:00:00.000Z',
      }),
    ).toThrow(/does not match/);
  });
});

describe('unavailableModerationState', () => {
  it('creates a fail-safe non-authoritative state', () => {
    expect(unavailableModerationState('Bad_Player')).toEqual({
      availability: 'unavailable',
      target: 'Bad_Player',
      duplicateStatus: 'none',
      activeSanctions: [],
    });
  });
});
