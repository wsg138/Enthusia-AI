import { describe, expect, it, vi } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import type {
  EnrichmentResult,
  ModerationDecision,
} from '@enthusia/moderation-adapter';
import type { StaffModerationStateSnapshot } from '@enthusia/integration-staff-moderation';
import {
  StaffModerationHistoryTool,
  type StaffModerationHistoryDeps,
} from '../src/moderation-history.js';

const DECISION: ModerationDecision = {
  eventId: 'event-1',
  occurredAt: '2026-10-07T12:00:00.000Z',
  platform: 'minecraft',
  semanticLabel: 'SEVERE_HARASSMENT',
  messageAction: 'BLOCK',
  reviewPriority: 'NORMAL',
  strikeRecommendation: 'STRIKE',
  containment: 'NONE',
  supportFlow: 'NONE',
  reasonCodes: ['harassment'],
  decisionSource: 'AI',
};

function staffSnapshot(
  version: 'v1' | 'v2' = 'v2',
  subjectId: string | null =
    '12345678-1234-4234-8234-123456789abc',
): StaffModerationStateSnapshot {
  return {
    service: 'enthusia-staff',
    api: 'ai-moderation-state',
    contractVersion: version,
    target: {
      requested: 'Bad_Player',
      playerId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      username: 'Bad_Player',
      ...(version === 'v2' && subjectId !== null
        ? { moderationSubjectId: subjectId }
        : {}),
    },
    activeSanctions: [],
    recentCases: [],
    fetchedAt: '2026-10-07T12:00:01.000Z',
  };
}

function enrichment(
  available = true,
): EnrichmentResult {
  return available
    ? {
        moderationAvailable: true,
        context: {
          subjectId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          decisions: [DECISION],
          fetchedAt: '2026-10-07T12:00:02.000Z',
          stale: false,
        },
      }
    : { moderationAvailable: false, context: null };
}

function deps(
  snapshot: StaffModerationStateSnapshot = staffSnapshot(),
  result: EnrichmentResult = enrichment(),
): StaffModerationHistoryDeps {
  return {
    staff: {
      getState: vi.fn(async () => snapshot),
    },
    moderation: {
      enrichContext: vi.fn(async () => result),
    },
  };
}

function staffContext() {
  return {
    traceId: '123e4567-e89b-42d3-a456-426614174000',
    actor: { id: 'staff-1', type: 'staff' as const },
    visibilityCeiling: Visibility.STAFF,
  };
}

describe('moderation.history', () => {
  it('uses only the authoritative Staff v2 subject for moderation lookup', async () => {
    const runtime = deps();
    const tool = new StaffModerationHistoryTool(runtime);

    const result = await tool.execute(
      { target: 'Bad_Player', limit: 5 },
      staffContext(),
    );

    expect(result.error).toBeUndefined();
    expect(runtime.staff.getState).toHaveBeenCalledWith('Bad_Player');
    expect(runtime.moderation.enrichContext).toHaveBeenCalledWith(
      {
        supportSubjectId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        moderationSubjectId: '12345678-1234-4234-8234-123456789abc',
      },
      { limit: 5 },
    );
    expect(result.visibility).toBe(Visibility.STAFF);
    expect(result.result).toEqual({
      target: {
        requested: 'Bad_Player',
        playerId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        username: 'Bad_Player',
      },
      decisions: [DECISION],
      fetchedAt: '2026-10-07T12:00:02.000Z',
    });
    expect(JSON.stringify(result.result)).not.toContain(
      '12345678-1234-4234-8234-123456789abc',
    );
  });

  it('refuses non-staff callers before either backend is touched', async () => {
    const runtime = deps();
    const tool = new StaffModerationHistoryTool(runtime);

    const result = await tool.execute(
      { target: 'Bad_Player' },
      {
        ...staffContext(),
        actor: { id: 'player-1', type: 'player' },
        visibilityCeiling: Visibility.PLAYER_SELF,
      },
    );

    expect(result.error).toMatchObject({
      code: 'MODERATION_HISTORY_DENIED',
      retryable: false,
    });
    expect(runtime.staff.getState).not.toHaveBeenCalled();
    expect(runtime.moderation.enrichContext).not.toHaveBeenCalled();
  });

  it('fails closed on Staff v1 rather than deriving an identity', async () => {
    const runtime = deps(staffSnapshot('v1'));
    const tool = new StaffModerationHistoryTool(runtime);

    const result = await tool.execute(
      { target: 'Bad_Player' },
      staffContext(),
    );

    expect(result.error).toMatchObject({
      code: 'STAFF_IDENTITY_CONTRACT_UNAVAILABLE',
      retryable: true,
    });
    expect(runtime.moderation.enrichContext).not.toHaveBeenCalled();
  });

  it('fails closed when Staff v2 has no current moderation subject', async () => {
    const runtime = deps(staffSnapshot('v2', null));
    const tool = new StaffModerationHistoryTool(runtime);

    const result = await tool.execute(
      { target: 'Bad_Player' },
      staffContext(),
    );

    expect(result.error).toMatchObject({
      code: 'MODERATION_SUBJECT_NOT_LINKED',
      retryable: false,
    });
    expect(runtime.moderation.enrichContext).not.toHaveBeenCalled();
  });

  it('keeps support available when AI moderation history is unavailable', async () => {
    const tool = new StaffModerationHistoryTool(
      deps(staffSnapshot(), enrichment(false)),
    );

    const result = await tool.execute(
      { target: 'Bad_Player' },
      staffContext(),
    );

    expect(result.error).toMatchObject({
      code: 'MODERATION_CONTEXT_UNAVAILABLE',
      retryable: true,
    });
    expect(result.result).toBeUndefined();
  });

  it('validates target and limit before network access', async () => {
    const runtime = deps();
    const tool = new StaffModerationHistoryTool(runtime);

    const badTarget = await tool.execute(
      { target: '../bad' },
      staffContext(),
    );
    const badLimit = await tool.execute(
      { target: 'Bad_Player', limit: 26 },
      staffContext(),
    );

    expect(badTarget.error?.code).toBe('INVALID_MODERATION_TARGET');
    expect(badLimit.error?.code).toBe('INVALID_MODERATION_HISTORY_LIMIT');
    expect(runtime.staff.getState).not.toHaveBeenCalled();
  });
});
