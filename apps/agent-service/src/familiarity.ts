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
    const current = this.memory.getCurrent(ref);
    if (current !== null && current.key.visibility !== Visibility.PLAYER_SELF) {
      return;
    }

    const previous =
      current === null ? null : parseMemoryValue(current.revision.value);
    if (previous === null && current !== null) return;
    if (previous?.level === 'EXPERT') return;

    const next = nextVerifiedHelpValue(previous);
    if (sameEffectiveValue(previous, next)) return;

    const evidence = [{
      sourceArtifactId: `conversation:${event.conversationId}`,
      sourceVersion: event.traceId,
      evidenceRole: EvidenceRole.SUPPORTING,
      observedAt: event.observedAt,
      verifiedAt: event.observedAt,
      authorityLevel: 'verified-agent-response',
    }];

    if (current === null) {
      await this.memory.createRevision({
        ...ref,
        visibility: Visibility.PLAYER_SELF,
        value: next,
        summary: familiaritySummary(topic, next),
        authority: MEMORY_AUTHORITY,
        validFrom: event.observedAt,
        evidence,
      });
      return;
    }

    await this.memory.supersede({
      ...ref,
      value: next,
      summary: familiaritySummary(topic, next),
      authority: MEMORY_AUTHORITY,
      reason: 'additional verified help for this topic',
      validFrom: event.observedAt,
      evidence,
      expectedCurrentRevisionId: current.revision.id,
    });
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

  return {
    tools: [tool],
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
  const level = value['level'];
  const confidence = value['confidence'];
  const verifiedHelpCount = value['verifiedHelpCount'];

  if (
    level !== 'NEW' &&
    level !== 'FAMILIAR' &&
    level !== 'EXPERT' &&
    level !== 'UNKNOWN'
  ) {
    return null;
  }
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return null;
  }
  if (
    typeof verifiedHelpCount !== 'number' ||
    !Number.isInteger(verifiedHelpCount) ||
    verifiedHelpCount < 0 ||
    verifiedHelpCount > MAX_AUTO_HELP_COUNT
  ) {
    return null;
  }

  return { level, confidence, verifiedHelpCount };
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
