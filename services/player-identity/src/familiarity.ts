import { canDisclose, SourceStatus, Visibility } from '@enthusia/contracts';
import type { Actor, ToolResult } from '@enthusia/contracts';
import type { Tool, ToolCallContext, ToolMetadata } from './tool.js';

export const TOPIC_FAMILIARITY_LEVELS = [
  'NEW',
  'FAMILIAR',
  'EXPERT',
  'UNKNOWN',
] as const;

export type TopicFamiliarityLevel = (typeof TOPIC_FAMILIARITY_LEVELS)[number];

export const TOPIC_FAMILIARITY_BASIS = [
  'CURRENT_CONTEXT',
  'CURRENT_MEMORY',
  'CONVERSATION',
] as const;

export type TopicFamiliarityBasis = (typeof TOPIC_FAMILIARITY_BASIS)[number];

export interface TopicFamiliaritySignal {
  topic: string;
  level: TopicFamiliarityLevel;
  confidence: number;
  basis: TopicFamiliarityBasis[];
  observedAt: string;
}

export interface TopicFamiliarityProvider {
  getTopicFamiliarity(input: {
    actor: Actor;
    topic: string;
    signal?: AbortSignal;
  }): Promise<TopicFamiliaritySignal>;
}

/**
 * Privacy-safe response-style hint.
 *
 * The model never supplies a target player id. The subject is always the
 * authenticated player actor from ToolCallContext, which prevents this tool
 * from becoming a general player-profile lookup.
 */
export class TopicFamiliarityTool
  implements Tool<{ topic: string }>
{
  readonly meta: ToolMetadata = {
    name: 'player.topic_familiarity',
    description:
      'Return a minimal topic-specific familiarity hint for the current player ' +
      '(NEW, FAMILIAR, EXPERT, or UNKNOWN) without exposing the underlying ' +
      'private memory/context used to derive it.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            'Short server-specific concept/topic whose explanation depth may be adapted.',
        },
      },
      required: ['topic'],
    },
    privacySensitive: true,
    maxVisibility: Visibility.PLAYER_SELF,
  };

  constructor(private readonly provider: TopicFamiliarityProvider) {}

  async execute(
    params: { topic: string },
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const timestamp = new Date().toISOString();
    const base = {
      toolName: this.meta.name,
      timestamp,
      source: 'player-context',
      visibility: Visibility.PLAYER_SELF,
      correlationId: ctx.traceId,
    };

    try {
      if (ctx.actor.type !== 'player') {
        return {
          ...base,
          error: {
            code: 'not_authorized',
            message: 'Topic familiarity is available only for the current player actor.',
            retryable: false,
          },
        };
      }
      if (
        !canDisclose(
          Visibility.PLAYER_SELF,
          ctx.visibilityCeiling,
          { isSubject: true, isStaff: false },
        )
      ) {
        return {
          ...base,
          error: {
            code: 'visibility_denied',
            message: 'Topic familiarity is above the request visibility ceiling.',
            retryable: false,
          },
        };
      }

      const topic = normalizeTopic(params.topic);
      const signal = normalizeSignal(
        await this.provider.getTopicFamiliarity({
          actor: ctx.actor,
          topic,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        }),
        topic,
      );

      return {
        ...base,
        freshness: JSON.stringify({
          version: `familiarity:${signal.observedAt}`,
          observedTime: signal.observedAt,
          sourceStatus: SourceStatus.CURRENT,
        }),
        result: signal,
      };
    } catch (error) {
      return {
        ...base,
        error: {
          code: 'familiarity_unavailable',
          message:
            error instanceof Error && error.message === 'invalid_topic'
              ? 'A valid topic is required.'
              : 'Topic familiarity is temporarily unavailable.',
          retryable:
            !(error instanceof Error && error.message === 'invalid_topic'),
        },
      };
    }
  }
}

function normalizeTopic(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_topic');
  const topic = value.trim().replace(/\s+/g, ' ');
  if (topic.length < 1 || topic.length > 160) throw new Error('invalid_topic');
  return topic;
}

function normalizeSignal(
  value: TopicFamiliaritySignal,
  requestedTopic: string,
): TopicFamiliaritySignal {
  if (!TOPIC_FAMILIARITY_LEVELS.includes(value.level)) {
    throw new Error('invalid_signal');
  }
  if (
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new Error('invalid_signal');
  }

  const observedAt = new Date(value.observedAt);
  if (!Number.isFinite(observedAt.getTime())) throw new Error('invalid_signal');

  const basis = [...new Set(value.basis)].filter(
    (item): item is TopicFamiliarityBasis =>
      TOPIC_FAMILIARITY_BASIS.includes(item),
  );
  if (basis.length !== value.basis.length) throw new Error('invalid_signal');

  return {
    topic: requestedTopic,
    level: value.level,
    confidence: value.confidence,
    basis,
    observedAt: observedAt.toISOString(),
  };
}
