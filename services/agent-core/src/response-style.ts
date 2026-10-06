import { Visibility } from '@enthusia/contracts';
import type {
  IntentClassification,
  ResolvedChatRequest,
  ResponseStyleProfile,
} from './types.js';
import type {
  Tool,
  ToolCallContext,
  ToolRegistry,
} from './tool.js';

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
  if (!wantsFamiliarity(request, classification)) return undefined;

  const topic = normalizeTopic(
    classification.familiarityTopic ?? classification.summary,
  );
  const fallback = unknownProfile(topic);
  const tool = deps.registry.get(TOPIC_FAMILIARITY_TOOL);
  if (!isFamiliarityTool(tool)) return fallback;

  const ctx = styleToolContext(request, deps.toolTimeoutMs);
  return executeStyleLookup(tool, topic, ctx, fallback);
}

function wantsFamiliarity(
  request: ResolvedChatRequest,
  classification: IntentClassification,
): boolean {
  return (
    classification.needsFamiliarityContext === true &&
    request.actor.type === 'player'
  );
}

/**
 * This special preflight is permitted only for the one subject-bound,
 * privacy-sensitive familiarity tool. A generic tool cannot opt into it.
 */
function isFamiliarityTool(tool: Tool | undefined): tool is Tool {
  if (tool === undefined) return false;
  if (tool.meta.name !== TOPIC_FAMILIARITY_TOOL) return false;
  if (tool.meta.privacySensitive !== true) return false;
  return tool.meta.maxVisibility === Visibility.PLAYER_SELF;
}

function styleToolContext(
  request: ResolvedChatRequest,
  configuredTimeoutMs: number | undefined,
): ToolCallContext {
  const timeoutMs = configuredTimeoutMs ?? DEFAULT_STYLE_TOOL_TIMEOUT_MS;
  const signal = timeoutSignal(timeoutMs);
  return {
    traceId: request.traceId,
    actor: request.actor,
    visibilityCeiling: request.visibilityCeiling,
    ...(signal !== undefined ? { signal } : {}),
  };
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout !== 'function') return undefined;
  return AbortSignal.timeout(timeoutMs);
}

async function executeStyleLookup(
  tool: Tool,
  topic: string,
  ctx: ToolCallContext,
  fallback: ResponseStyleProfile,
): Promise<ResponseStyleProfile> {
  try {
    const envelope = await tool.execute({ topic }, ctx);
    return profileFromEnvelope(envelope, topic) ?? fallback;
  } catch {
    return fallback;
  }
}

function profileFromEnvelope(
  envelope: Awaited<ReturnType<Tool['execute']>>,
  topic: string,
): ResponseStyleProfile | null {
  if (envelope.error !== undefined) return null;
  if (envelope.visibility !== Visibility.PLAYER_SELF) return null;
  return parseProfile(envelope.result, topic);
}

function parseProfile(
  value: unknown,
  requestedTopic: string,
): ResponseStyleProfile | null {
  if (!isRecord(value)) return null;

  const level = parseLevel(value['level']);
  if (level === null) return null;

  const confidence = parseConfidence(value['confidence']);
  if (confidence === null) return null;

  const basis = parseBasis(value['basis']);
  if (basis === null) return null;

  return {
    topic: requestedTopic,
    familiarity: normalizedFamiliarity(level, confidence),
    confidence,
    basis,
  };
}

function parseLevel(
  value: unknown,
): ResponseStyleProfile['familiarity'] | null {
  if (typeof value !== 'string') return null;
  if (!LEVELS.has(value)) return null;
  return value as ResponseStyleProfile['familiarity'];
}

function parseConfidence(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function parseBasis(
  value: unknown,
): ResponseStyleProfile['basis'] | null {
  if (!Array.isArray(value)) return null;

  const parsed: ResponseStyleProfile['basis'] = [];
  for (const raw of value) {
    const item = parseBasisItem(raw);
    if (item === null) return null;
    parsed.push(item);
  }
  return [...new Set(parsed)];
}

function parseBasisItem(
  value: unknown,
): ResponseStyleProfile['basis'][number] | null {
  if (typeof value !== 'string') return null;
  if (!BASES.has(value)) return null;
  return value as ResponseStyleProfile['basis'][number];
}

function normalizedFamiliarity(
  level: ResponseStyleProfile['familiarity'],
  confidence: number,
): ResponseStyleProfile['familiarity'] {
  return confidence < MIN_FAMILIARITY_CONFIDENCE ? 'UNKNOWN' : level;
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
