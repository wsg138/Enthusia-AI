import { Visibility } from '@enthusia/contracts';
import type { ResolvedChatRequest, IntentClassification, ResponseStyleProfile } from './types.js';
import type { ToolCallContext, ToolRegistry } from './tool.js';

export const TOPIC_FAMILIARITY_TOOL = 'player.topic_familiarity';
export const MIN_FAMILIARITY_CONFIDENCE = 0.6;
export const DEFAULT_STYLE_TOOL_TIMEOUT_MS = 5_000;

const LEVELS = new Set(['NEW', 'FAMILIAR', 'EXPERT', 'UNKNOWN']);
const BASES = new Set(['CURRENT_CONTEXT', 'CURRENT_MEMORY', 'CONVERSATION']);

export interface ResponseStyleDeps {
  registry: ToolRegistry;
  toolTimeoutMs?: number;
}

/**
 * Resolve a response-style hint without turning private player memory into
 * factual answer evidence. Failure is intentionally quiet: the caller gets
 * UNKNOWN and the normal verified answer path continues.
 */
export async function resolveResponseStyle(
  request: ResolvedChatRequest,
  classification: IntentClassification,
  deps: ResponseStyleDeps,
): Promise<ResponseStyleProfile | undefined> {
  if (
    classification.needsFamiliarityContext !== true ||
    request.actor.type !== 'player'
  ) {
    return undefined;
  }

  const topic = normalizeTopic(
    classification.familiarityTopic ?? classification.summary,
  );
  const fallback = unknownProfile(topic);
  const tool = deps.registry.get(TOPIC_FAMILIARITY_TOOL);
  if (!tool) return fallback;

  // This special preflight is permitted only for the one subject-bound,
  // privacy-sensitive familiarity tool. A generic tool cannot opt into it.
  if (
    tool.meta.name !== TOPIC_FAMILIARITY_TOOL ||
    tool.meta.privacySensitive !== true ||
    tool.meta.maxVisibility !== Visibility.PLAYER_SELF
  ) {
    return fallback;
  }

  const timeoutMs = deps.toolTimeoutMs ?? DEFAULT_STYLE_TOOL_TIMEOUT_MS;
  const timeoutSignal =
    typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const ctx: ToolCallContext = {
    traceId: request.traceId,
    actor: request.actor,
    visibilityCeiling: request.visibilityCeiling,
    ...(timeoutSignal !== undefined ? { signal: timeoutSignal } : {}),
  };

  try {
    const envelope = await tool.execute({ topic }, ctx);
    if (
      envelope.error !== undefined ||
      envelope.visibility !== Visibility.PLAYER_SELF
    ) {
      return fallback;
    }
    const parsed = parseProfile(envelope.result, topic);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function parseProfile(
  value: unknown,
  requestedTopic: string,
): ResponseStyleProfile | null {
  if (!isRecord(value)) return null;

  const level = value['level'];
  const confidence = value['confidence'];
  const basis = value['basis'];
  if (
    typeof level !== 'string' ||
    !LEVELS.has(level) ||
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    !Array.isArray(basis)
  ) {
    return null;
  }

  const parsedBasis: ResponseStyleProfile['basis'] = [];
  for (const raw of basis) {
    if (typeof raw !== 'string' || !BASES.has(raw)) return null;
    parsedBasis.push(raw as ResponseStyleProfile['basis'][number]);
  }

  return {
    topic: requestedTopic,
    familiarity:
      confidence < MIN_FAMILIARITY_CONFIDENCE
        ? 'UNKNOWN'
        : (level as ResponseStyleProfile['familiarity']),
    confidence,
    basis: [...new Set(parsedBasis)],
  };
}

function unknownProfile(topic: string): ResponseStyleProfile {
  return {
    topic,
    familiarity: 'UNKNOWN',
    confidence: 0,
    basis: [],
  };
}

function normalizeTopic(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) return 'server concept';
  return normalized.slice(0, 160);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
