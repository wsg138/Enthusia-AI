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

interface FamiliarityEnvelopeBase {
  toolName: string;
  timestamp: string;
  source: 'player-context';
  visibility: Visibility.PLAYER_SELF;
  correlationId: string;
}

interface FamiliarityToolError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Privacy-safe response-style hint.
 *
 * The model never supplies a target player id. The subject is always the
 * authenticated player actor from ToolCallContext, which prevents this tool
 * from becoming a general player-profile lookup.
 */
export class TopicFamiliarityTool implements Tool<{ topic: string }> {
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
    const base = envelopeBase(this.meta.name, ctx);
    const accessError = familiarityAccessError(ctx);
    if (accessError !== null) {
      return { ...base, error: accessError };
    }

    try {
      const topic = normalizeTopic(params.topic);
      const signal = await loadNormalizedSignal(this.provider, ctx, topic);
      return successEnvelope(base, signal);
    } catch (error) {
      return { ...base, error: unavailableError(error) };
    }
  }
}

function envelopeBase(
  toolName: string,
  ctx: ToolCallContext,
): FamiliarityEnvelopeBase {
  return {
    toolName,
    timestamp: new Date().toISOString(),
    source: 'player-context',
    visibility: Visibility.PLAYER_SELF,
    correlationId: ctx.traceId,
  };
}

function familiarityAccessError(
  ctx: ToolCallContext,
): FamiliarityToolError | null {
  if (ctx.actor.type !== 'player') {
    return {
      code: 'not_authorized',
      message: 'Topic familiarity is available only for the current player actor.',
      retryable: false,
    };
  }

  const allowed = canDisclose(
    Visibility.PLAYER_SELF,
    ctx.visibilityCeiling,
    { isSubject: true, isStaff: false },
  );
  if (allowed) return null;

  return {
    code: 'visibility_denied',
    message: 'Topic familiarity is above the request visibility ceiling.',
    retryable: false,
  };
}

async function loadNormalizedSignal(
  provider: TopicFamiliarityProvider,
  ctx: ToolCallContext,
  topic: string,
): Promise<TopicFamiliaritySignal> {
  const raw = await provider.getTopicFamiliarity({
    actor: ctx.actor,
    topic,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  return normalizeSignal(raw, topic);
}

function successEnvelope(
  base: FamiliarityEnvelopeBase,
  signal: TopicFamiliaritySignal,
): ToolResult<unknown> {
  return {
    ...base,
    freshness: JSON.stringify({
      version: `familiarity:${signal.observedAt}`,
      observedTime: signal.observedAt,
      sourceStatus: SourceStatus.CURRENT,
    }),
    result: signal,
  };
}

function unavailableError(error: unknown): FamiliarityToolError {
  const invalidTopic =
    error instanceof Error && error.message === 'invalid_topic';
  return {
    code: 'familiarity_unavailable',
    message: invalidTopic
      ? 'A valid topic is required.'
      : 'Topic familiarity is temporarily unavailable.',
    retryable: !invalidTopic,
  };
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
  validateLevel(value.level);
  validateConfidence(value.confidence);
  const observedAt = normalizeObservedAt(value.observedAt);
  const basis = normalizeBasis(value.basis);

  return {
    topic: requestedTopic,
    level: value.level,
    confidence: value.confidence,
    basis,
    observedAt,
  };
}

function validateLevel(level: TopicFamiliarityLevel): void {
  if (!TOPIC_FAMILIARITY_LEVELS.includes(level)) {
    throw new Error('invalid_signal');
  }
}

function validateConfidence(confidence: number): void {
  if (!Number.isFinite(confidence)) throw new Error('invalid_signal');
  if (confidence < 0 || confidence > 1) throw new Error('invalid_signal');
}

function normalizeObservedAt(value: string): string {
  const observedAt = new Date(value);
  if (!Number.isFinite(observedAt.getTime())) throw new Error('invalid_signal');
  return observedAt.toISOString();
}

function normalizeBasis(
  values: TopicFamiliarityBasis[],
): TopicFamiliarityBasis[] {
  const basis = [...new Set(values)];
  for (const item of basis) {
    if (!TOPIC_FAMILIARITY_BASIS.includes(item)) {
      throw new Error('invalid_signal');
    }
  }
  return basis;
}
