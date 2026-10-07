import { EvidenceRole, Visibility, type Actor } from '@enthusia/contracts';
import {
  MemoryService,
  type CurrentMemory,
  type MemoryRef,
} from '@enthusia/memory';
import {
  TopicFamiliarityTool,
  type TopicFamiliarityLevel,
  type TopicFamiliarityProvider,
  type TopicFamiliaritySignal,
} from '@enthusia/player-identity';
import type { Tool } from '@enthusia/agent-core';
import type { VerifiedTopicHelpEvent } from '@enthusia/agent-core';
import { PublicCurrentMemoryTool } from './current-memory.js';

const MEMORY_NAMESPACE = 'player';
const MEMORY_KEY_PREFIX = 'topic_familiarity.';
const MEMORY_AUTHORITY = 'agent-service:verified-help';
const MAX_TOPIC_LENGTH = 80;
const MAX_AUTO_HELP_COUNT = 3;

interface FamiliarityMemoryValue {
  level: TopicFamiliarityLevel;
  confidence: number;
  verifiedHelpCount: number;
}

export interface FamiliarityRuntime {
  tools: Tool[];
  onVerifiedTopicHelp?: (event: VerifiedTopicHelpEvent) => Promise<void>;
  close(): void;
}

export class MemoryTopicFamiliarityProvider
  implements TopicFamiliarityProvider
{
  constructor(
    private readonly memory: MemoryService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getTopicFamiliarity(input: {
    actor: Actor;
    topic: string;
    signal?: AbortSignal;
  }): Promise<TopicFamiliaritySignal> {
    input.signal?.throwIfAborted();
    const topic = canonicalTopic(input.topic);
    const current = this.memory.getCurrent(familiarityRef(input.actor, topic));
    if (!isUsableFamiliarityMemory(current)) {
      return unknownSignal(topic, this.now());
    }

    const value = parseMemoryValue(current.revision.value);
    if (value === null) {
      return unknownSignal(topic, this.now());
    }

    return {
      topic,
      level: value.level,
      confidence: value.confidence,
      basis: ['CURRENT_MEMORY'],
      observedAt:
        current.revision.verifiedAt ?? current.revision.createdAt,
    };
  }
}

export class VerifiedHelpFamiliarityRecorder {
  constructor(
    private readonly memory: MemoryService,
  ) {}

  async record(event: VerifiedTopicHelpEvent): Promise<void> {
    if (event.actor.type !== 'player') return;

    const topic = canonicalTopic(event.topic);
    const ref = familiarityRef(event.actor, topic);
    const state = readRecorderState(this.memory.getCurrent(ref));
    if (state.kind !== 'usable') return;

    const next = nextVerifiedHelpValue(state.previous);
    if (sameEffectiveValue(state.previous, next)) return;

    await persistVerifiedHelp(
      this.memory,
      ref,
      topic,
      event,
      state.current,
      next,
    );
  }
}

export function loadConfiguredFamiliarityRuntime(
  memoryPath: string | undefined,
): FamiliarityRuntime {
  if (memoryPath === undefined) {
    return { tools: [], close: () => undefined };
  }

  const memory = new MemoryService({ path: memoryPath });
  const provider = new MemoryTopicFamiliarityProvider(memory);
  const recorder = new VerifiedHelpFamiliarityRecorder(memory);
  const tool = new TopicFamiliarityTool(provider) as Tool;
  const currentMemory = new PublicCurrentMemoryTool(memory) as Tool;

  return {
    tools: [tool, currentMemory],
    onVerifiedTopicHelp: (event) => recorder.record(event),
    close: () => memory.close(),
  };
}

export function familiarityRef(actor: Actor, topic: string): MemoryRef {
  const subject = actor.linkedUuid?.trim() || actor.id.trim();
  if (subject.length === 0) {
    throw new Error('player familiarity requires a stable actor identity');
  }
  return {
    namespace: MEMORY_NAMESPACE,
    key: `${MEMORY_KEY_PREFIX}${canonicalTopic(topic)}`,
    scope: `player:${subject}`,
  };
}

export function canonicalTopic(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (
    normalized.length === 0 ||
    normalized.length > MAX_TOPIC_LENGTH ||
    !/^[a-z0-9][a-z0-9 ._/-]*$/.test(normalized)
  ) {
    throw new Error('invalid familiarity topic');
  }
  return normalized;
}

function isUsableFamiliarityMemory(
  current: CurrentMemory | null,
): current is CurrentMemory {
  return (
    current !== null &&
    current.key.visibility === Visibility.PLAYER_SELF &&
    current.revision.evidence.length > 0
  );
}

function parseMemoryValue(value: unknown): FamiliarityMemoryValue | null {
  if (!isRecord(value)) return null;

  const level = parseLevel(value['level']);
  const confidence = parseConfidence(value['confidence']);
  const verifiedHelpCount = parseHelpCount(value['verifiedHelpCount']);
  if (
    level === null ||
    confidence === null ||
    verifiedHelpCount === null
  ) {
    return null;
  }

  return { level, confidence, verifiedHelpCount };
}

function parseLevel(value: unknown): TopicFamiliarityLevel | null {
  const levels: readonly TopicFamiliarityLevel[] = [
    'NEW',
    'FAMILIAR',
    'EXPERT',
    'UNKNOWN',
  ];
  return typeof value === 'string' &&
    levels.includes(value as TopicFamiliarityLevel)
    ? (value as TopicFamiliarityLevel)
    : null;
}

function parseConfidence(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  return value >= 0 && value <= 1 ? value : null;
}

function parseHelpCount(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value)) return null;
  return value >= 0 && value <= MAX_AUTO_HELP_COUNT ? value : null;
}

type RecorderState =
  | { kind: 'ignore' }
  | {
      kind: 'usable';
      current: CurrentMemory | null;
      previous: FamiliarityMemoryValue | null;
    };

function readRecorderState(current: CurrentMemory | null): RecorderState {
  if (current === null) {
    return { kind: 'usable', current: null, previous: null };
  }
  if (current.key.visibility !== Visibility.PLAYER_SELF) {
    return { kind: 'ignore' };
  }

  const previous = parseMemoryValue(current.revision.value);
  if (previous === null || previous.level === 'EXPERT') {
    return { kind: 'ignore' };
  }
  return { kind: 'usable', current, previous };
}

async function persistVerifiedHelp(
  memory: MemoryService,
  ref: MemoryRef,
  topic: string,
  event: VerifiedTopicHelpEvent,
  current: CurrentMemory | null,
  next: FamiliarityMemoryValue,
): Promise<void> {
  const evidence = verifiedHelpEvidence(event);
  const common = {
    ...ref,
    value: next,
    summary: familiaritySummary(topic, next),
    authority: MEMORY_AUTHORITY,
    validFrom: event.observedAt,
    evidence,
  };

  if (current === null) {
    await memory.createRevision({
      ...common,
      visibility: Visibility.PLAYER_SELF,
    });
    return;
  }

  await memory.supersede({
    ...common,
    reason: 'additional verified help for this topic',
    expectedCurrentRevisionId: current.revision.id,
  });
}

function verifiedHelpEvidence(event: VerifiedTopicHelpEvent) {
  return [{
    sourceArtifactId: `conversation:${event.conversationId}`,
    sourceVersion: event.traceId,
    evidenceRole: EvidenceRole.SUPPORTING,
    observedAt: event.observedAt,
    verifiedAt: event.observedAt,
    authorityLevel: 'verified-agent-response',
  }];
}

function nextVerifiedHelpValue(
  previous: FamiliarityMemoryValue | null,
): FamiliarityMemoryValue {
  const count = Math.min(
    MAX_AUTO_HELP_COUNT,
    (previous?.verifiedHelpCount ?? 0) + 1,
  );
  const confidence = count === 1 ? 0.5 : count === 2 ? 0.7 : 0.85;
  return {
    level: 'FAMILIAR',
    confidence,
    verifiedHelpCount: count,
  };
}

function sameEffectiveValue(
  previous: FamiliarityMemoryValue | null,
  next: FamiliarityMemoryValue,
): boolean {
  return (
    previous !== null &&
    previous.level === next.level &&
    previous.confidence === next.confidence &&
    previous.verifiedHelpCount === next.verifiedHelpCount
  );
}

function familiaritySummary(
  topic: string,
  value: FamiliarityMemoryValue,
): string {
  return (
    `Player familiarity with "${topic}": ${value.level.toLowerCase()} ` +
    `after ${value.verifiedHelpCount} verified help interaction(s).`
  );
}

function unknownSignal(topic: string, now: Date): TopicFamiliaritySignal {
  return {
    topic,
    level: 'UNKNOWN',
    confidence: 0,
    basis: [],
    observedAt: now.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
