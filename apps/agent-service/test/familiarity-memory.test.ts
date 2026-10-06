import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Visibility, type Actor } from '@enthusia/contracts';
import { MemoryService } from '@enthusia/memory';
import {
  CurrentMemoryFamiliarityProvider,
  familiarityMemoryRef,
  familiarityPlayerScope,
  familiarityTopicKey,
  loadConfiguredFamiliarityTools,
} from '../src/familiarity-memory.js';

const PLAYER: Actor = {
  id: '100000000000000001',
  type: 'player',
  linkedUuid: '123e4567-e89b-12d3-a456-426614174000',
};

async function seedFamiliarity(
  memory: MemoryService,
  topic: string,
  value: unknown,
): Promise<void> {
  const ref = familiarityMemoryRef(PLAYER, topic);
  await memory.createRevision({
    ...ref,
    value,
    summary: `Familiarity signal for ${topic}`,
    authority: 'test:verified-help',
    visibility: Visibility.PLAYER_SELF,
  });
}

describe('CurrentMemoryFamiliarityProvider', () => {
  it('returns only a valid CURRENT familiarity revision', async () => {
    const memory = new MemoryService();
    try {
      await seedFamiliarity(memory, 'Reputation System', {
        schemaVersion: 1,
        level: 'FAMILIAR',
        confidence: 0.84,
      });
      const provider = new CurrentMemoryFamiliarityProvider(memory);
      await expect(
        provider.getTopicFamiliarity({
          actor: PLAYER,
          topic: 'reputation system',
        }),
      ).resolves.toMatchObject({
        topic: 'reputation system',
        level: 'FAMILIAR',
        confidence: 0.84,
        basis: ['CURRENT_MEMORY'],
      });
    } finally {
      memory.close();
    }
  });

  it('excludes STALE memory through W05 current-only retrieval', async () => {
    const memory = new MemoryService();
    try {
      await seedFamiliarity(memory, 'events', {
        schemaVersion: 1,
        level: 'EXPERT',
        confidence: 0.98,
      });
      await memory.markStale(familiarityMemoryRef(PLAYER, 'events'), {
        reason: 'test source no longer current',
        authority: 'test',
      });

      const provider = new CurrentMemoryFamiliarityProvider(memory);
      await expect(
        provider.getTopicFamiliarity({ actor: PLAYER, topic: 'events' }),
      ).resolves.toMatchObject({
        level: 'UNKNOWN',
        confidence: 0,
        basis: [],
      });
    } finally {
      memory.close();
    }
  });

  it('treats malformed current familiarity values as UNKNOWN', async () => {
    const memory = new MemoryService();
    try {
      await seedFamiliarity(memory, 'mail', {
        schemaVersion: 1,
        level: 'EXPERT',
        confidence: 8,
      });
      const provider = new CurrentMemoryFamiliarityProvider(memory);
      await expect(
        provider.getTopicFamiliarity({ actor: PLAYER, topic: 'mail' }),
      ).resolves.toMatchObject({
        level: 'UNKNOWN',
        confidence: 0,
        basis: [],
      });
    } finally {
      memory.close();
    }
  });
});

describe('familiarity memory identity', () => {
  it('uses linked Minecraft identity for cross-surface continuity', () => {
    expect(familiarityPlayerScope(PLAYER)).toBe(
      'minecraft:123e4567-e89b-12d3-a456-426614174000',
    );
    expect(
      familiarityPlayerScope({ id: 'discord-only', type: 'player' }),
    ).toBe('actor:discord-only');
  });

  it('canonicalizes equivalent topic spelling into one memory key', () => {
    expect(familiarityTopicKey('  Reputation-System  ')).toBe(
      'topic:reputation-system',
    );
    expect(familiarityTopicKey('REPUTATION system')).toBe(
      'topic:reputation-system',
    );
  });
});

describe('production familiarity runtime resource', () => {
  it('stays unregistered when no persistent memory path is configured', () => {
    const resource = loadConfiguredFamiliarityTools(undefined);
    expect(resource.tools).toEqual([]);
    expect(() => resource.close()).not.toThrow();
  });

  it('reads the configured persistent W05 database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'enthusia-familiarity-'));
    const dbPath = join(dir, 'memory.sqlite');
    const writer = new MemoryService({ path: dbPath });
    try {
      await seedFamiliarity(writer, 'reputation', {
        schemaVersion: 1,
        level: 'FAMILIAR',
        confidence: 0.8,
      });
    } finally {
      writer.close();
    }

    const resource = loadConfiguredFamiliarityTools(dbPath);
    try {
      expect(resource.tools.map((tool) => tool.meta.name)).toEqual([
        'player.topic_familiarity',
      ]);
      const result = await resource.tools[0]!.execute(
        { topic: 'reputation' },
        {
          traceId: 'trace-persistent-familiarity',
          actor: PLAYER,
          visibilityCeiling: Visibility.PLAYER_SELF,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({
        level: 'FAMILIAR',
        confidence: 0.8,
        basis: ['CURRENT_MEMORY'],
      });
    } finally {
      resource.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
