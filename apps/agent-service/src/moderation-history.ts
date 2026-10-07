import {
  SourceStatus,
  Visibility,
  visibilityRank,
  type ToolResult,
} from '@enthusia/contracts';
import {
  encodeFreshness,
  type Tool,
  type ToolCallContext,
  type ToolMetadata,
} from '@enthusia/agent-core';
import type {
  StaffModerationStateClient,
  StaffModerationStateSnapshot,
} from '@enthusia/integration-staff-moderation';
import type {
  EnrichmentResult,
  ModerationAdapter,
  ModerationDecision,
} from '@enthusia/moderation-adapter';

const SOURCE = 'enthusia-staff+ai-moderation-api';
const USERNAME = /^[A-Za-z0-9_]{3,16}$/;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export interface StaffModerationHistoryDeps {
  staff: Pick<StaffModerationStateClient, 'getState'>;
  moderation: Pick<ModerationAdapter, 'enrichContext'>;
}

export interface StaffModerationHistoryResult {
  target: {
    requested: string;
    playerId: string;
    username?: string | null;
  };
  decisions: readonly ModerationDecision[];
  fetchedAt: string;
}

export class StaffModerationHistoryTool
  implements Tool<{ target: string; limit?: number }>
{
  readonly meta: ToolMetadata = {
    name: 'moderation.history',
    description:
      'Read privacy-minimized effective AI-moderation history for an exact ' +
      'Minecraft target. Staff-only. The target is resolved through the ' +
      'authoritative EnthusiaStaff moderation subject before history lookup.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Exact current Minecraft username.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum meaningful decisions to return (1..25).',
        },
      },
      required: ['target'],
    },
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: Visibility.STAFF,
  };

  constructor(private readonly deps: StaffModerationHistoryDeps) {}

  async execute(
    params: { target: string; limit?: number },
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const timestamp = new Date().toISOString();
    try {
      requireStaff(ctx);
      const target = validatedTarget(params.target);
      const limit = validatedLimit(params.limit);
      ctx.signal?.throwIfAborted();

      const staff = await this.deps.staff.getState(target);
      const moderationSubjectId = authoritativeModerationSubject(staff);
      ctx.signal?.throwIfAborted();

      const enrichment = await this.deps.moderation.enrichContext(
        {
          supportSubjectId: staff.target.playerId,
          moderationSubjectId,
        },
        { limit },
      );
      const context = requireModerationContext(enrichment);
      return {
        toolName: this.meta.name,
        timestamp,
        source: SOURCE,
        visibility: Visibility.STAFF,
        correlationId: ctx.traceId,
        freshness: encodeFreshness({
          version:
            `staff:${staff.contractVersion};ai-moderation:support-context-v1`,
          observedTime: context.fetchedAt,
          sourceStatus: SourceStatus.CURRENT,
        }),
        result: {
          target: {
            requested: staff.target.requested,
            playerId: staff.target.playerId,
            ...(staff.target.username !== undefined
              ? { username: staff.target.username }
              : {}),
          },
          decisions: context.decisions,
          fetchedAt: context.fetchedAt,
        } satisfies StaffModerationHistoryResult,
      };
    } catch (error) {
      return {
        toolName: this.meta.name,
        timestamp,
        source: SOURCE,
        visibility: Visibility.STAFF,
        correlationId: ctx.traceId,
        error: safeHistoryError(error),
      };
    }
  }
}

function requireStaff(ctx: ToolCallContext): void {
  const staffCeiling =
    visibilityRank(ctx.visibilityCeiling) >= visibilityRank(Visibility.STAFF);
  if (ctx.actor.type === 'staff' && staffCeiling) return;
  throw new HistoryToolError(
    'MODERATION_HISTORY_DENIED',
    'Moderation history is available only to authorized staff.',
    false,
  );
}

function validatedTarget(value: unknown): string {
  if (typeof value === 'string' && USERNAME.test(value)) return value;
  throw new HistoryToolError(
    'INVALID_MODERATION_TARGET',
    'Moderation history requires an exact Minecraft username.',
    false,
  );
}

function validatedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_LIMIT
  ) {
    return value;
  }
  throw new HistoryToolError(
    'INVALID_MODERATION_HISTORY_LIMIT',
    'Moderation history limit must be an integer from 1 through 25.',
    false,
  );
}

function authoritativeModerationSubject(
  staff: StaffModerationStateSnapshot,
): string {
  if (staff.contractVersion !== 'v2') {
    throw new HistoryToolError(
      'STAFF_IDENTITY_CONTRACT_UNAVAILABLE',
      'Authoritative moderation identity is not available from the deployed Staff read contract.',
      true,
    );
  }
  const subject = staff.target.moderationSubjectId;
  if (typeof subject === 'string' && subject.length > 0) return subject;
  throw new HistoryToolError(
    'MODERATION_SUBJECT_NOT_LINKED',
    'No authoritative moderation subject is available for that target.',
    false,
  );
}

function requireModerationContext(
  enrichment: EnrichmentResult,
): NonNullable<EnrichmentResult['context']> {
  if (enrichment.moderationAvailable && enrichment.context !== null) {
    return enrichment.context;
  }
  throw new HistoryToolError(
    'MODERATION_CONTEXT_UNAVAILABLE',
    'Moderation history is temporarily unavailable.',
    true,
  );
}

class HistoryToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HistoryToolError';
  }
}

function safeHistoryError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof HistoryToolError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      code: 'MODERATION_HISTORY_ABORTED',
      message: 'Moderation history lookup was cancelled.',
      retryable: true,
    };
  }
  return {
    code: 'MODERATION_HISTORY_UNAVAILABLE',
    message: 'Moderation history could not be read safely.',
    retryable: true,
  };
}
