import { z } from 'zod';
import type { Actor } from '@enthusia/contracts';
import {
  MemoryService,
  type CurrentMemory,
  type MemoryRef,
} from '@enthusia/memory';
import {
  TopicFamiliarityTool,
  type TopicFamiliarityProvider,
  type TopicFamiliaritySignal,
} from '@enthusia/player-identity';
import type { Tool } from '@enthusia/agent-core';

export const PLAYER_FAMILIARITY_NAMESPACE = 'player-topic-familiarity';
export const PLAYER_FAMILIARITY_SCHEMA_VERSION = 1;

const familiarityValueSchema = z.strictObject({
  schemaVersion: z.literal(PLAYER_FAMILIARITY_SCHEMA_VERSION),
  level: z.enum(['NEW', 'FAMILIAR', 'EXPERT', 'UNKNOWN']),
  confidence: z.number().min(0).max(1),
});

export type StoredFamiliarityValue = z.infer<typeof familiarityValueSchema>;

type CurrentMemoryReader = Pick<MemoryService, 'getCurrent'>;

export interface FamiliarityToolResource {
  tools: Tool[];
  close(): void;
}

/**
 * Production familiarity provider backed by W05 current memory.
 *
 * getCurrent() intentionally excludes SUPERSEDED, INVALID, STALE, and
 * CONFLICTED revisions. A missing/malformed value degrades to UNKNOWN instead
 * of guessing from rank, account age, or unrelated private history.
 */
export class CurrentMemoryFamiliarityProvider
  implements TopicFamiliarityProvider
{
  constructor(private readonly memory: CurrentMemoryReader) {}

  async getTopicFamiliarity(input: {
    actor: Actor;
    topic: string;
    signal?: AbortSignal;
  }): Promise<TopicFamiliaritySignal> {
    input.signal?.throwIfAborted();
    const current = this.memory.getCurrent(
      familiarityMemoryRef(input.actor, input.topic),
    );
    input.signal?.throwIfAborted();
    return signalFromCurrentMemory(input.topic, current);
  }
}

export function loadConfiguredFamiliarityTools(
  memoryDbPath: string | undefined,
): FamiliarityToolResource {
  if (memoryDbPath === undefined) return emptyResource();

  const memory = new MemoryService({ path: memoryDbPath });
  const provider = new CurrentMemoryFamiliarityProvider(memory);
  let closed = false;

  return {
    tools: [new TopicFamiliarityTool(provider) as Tool],
    close() {
      if (closed) return;
      closed = true;
      memory.close();
    },
  };
}

export function familiarityMemoryRef(
  actor: Actor,
  topic: string,
): MemoryRef {
  if (actor.type !== 'player') {
    throw new Error('familiarity memory requires a player actor');
  }
  return {
    namespace: PLAYER_FAMILIARITY_NAMESPACE,
    key: familiarityTopicKey(topic),
    scope: familiarityPlayerScope(actor),
  };
}

export function familiarityTopicKey(topic: string): string {
  const normalized = topic
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '-');
  if (normalized.length === 0) {
    throw new Error('familiarity topic cannot be empty');
  }
  return `topic:${normalized.slice(0, 160)}`;
}

export function familiarityPlayerScope(actor: Actor): string {
  const linked = actor.linkedUuid?.trim().toLowerCase();
  if (linked) return `minecraft:${linked}`;
  return `actor:${actor.id}`;
}

function signalFromCurrentMemory(
  requestedTopic: string,
  current: CurrentMemory | null,
): TopicFamiliaritySignal {
  if (current === null) return unknownSignal(requestedTopic);

  const parsed = familiarityValueSchema.safeParse(current.revision.value);
  if (!parsed.success) {
    return unknownSignal(requestedTopic, observationTime(current));
  }

  return {
    topic: requestedTopic,
    level: parsed.data.level,
    confidence: parsed.data.confidence,
    basis: ['CURRENT_MEMORY'],
    observedAt: observationTime(current),
  };
}

function observationTime(current: CurrentMemory): string {
  return current.revision.verifiedAt ?? current.revision.createdAt;
}

function unknownSignal(
  topic: string,
  observedAt = new Date().toISOString(),
): TopicFamiliaritySignal {
  return {
    topic,
    level: 'UNKNOWN',
    confidence: 0,
    basis: [],
    observedAt,
  };
}

function emptyResource(): FamiliarityToolResource {
  return {
    tools: [],
    close() {},
  };
}
