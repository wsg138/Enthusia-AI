import { describe, expect, it } from 'vitest';
import {
  EvidenceRole,
  Visibility,
  type Actor,
} from '@enthusia/contracts';
import { MemoryService } from '@enthusia/memory';
import type { VerifiedTopicHelpEvent } from '@enthusia/agent-core';
import {
  MemoryTopicFamiliarityProvider,
  VerifiedHelpFamiliarityRecorder,
  canonicalTopic,
  familiarityRef,
  loadConfiguredFamiliarityRuntime,
} from '../src/familiarity.js';

const PLAYER: Actor = {
  id: '100000000000000001',
  type: 'player',
  linkedUuid: '123e4567-e89b-12d3-a456-426614174000',
};

function event(overrides: Partial<VerifiedTopicHelpEvent> = {}): VerifiedTopicHelpEvent {
  return {
    actor: PLAYER,
    topic: 'reputation',
    conversationId: 'discord:guild:ticket-1',
    traceId: '123e4567-e89b-42d3-a456-426614174000',
    observedAt: '2026-10-06T06:00:00.000Z',
    supportedDirectClaims: 1,
    ...overrides,
  };
}

function seed(
  memory: MemoryService,
  value: unknown,
  visibility = Visibility.PLAYER_SELF,
) {
  return memory.createRevision({
    ...familiarityRef(PLAYER, 'reputation'),
    visibility,
    value,
    summary: 'test familiarity',
    authority: 'test',
    evidence: [{
      sourceArtifactId: 'conversation:test',
      sourceVersion: 'trace-test',
      evidenceRole: EvidenceRole.SUPPORTING,
      observedAt: '2026-10-06T05:00:00.000Z',
      verifiedAt: '2026-10-06T05:00:00.000Z',
    }],
  });
}

describe('memory-backed topic familiarity', () => {
  it('returns UNKNOWN when no current familiarity memory exists', async () => {
    const memory = new MemoryService();
    const provider = new MemoryTopicFamiliarityProvider(
      memory,
      () => new Date('2026-10-06T06:00:00.000Z'),
    );
    await expect(provider.getTopicFamiliarity({
      actor: PLAYER,
      topic: 'Reputation',
    })).resolves.toEqual({
      topic: 'reputation',
      level: 'UNKNOWN',
      confidence: 0,
      basis: [],
      observedAt: '2026-10-06T06:00:00.000Z',
    });
    memory.close();
  });

  it('reads only evidence-backed PLAYER_SELF current memory', async () => {
    const memory = new MemoryService();
    await seed(memory, {
      level: 'FAMILIAR',
      confidence: 0.72,
      verifiedHelpCount: 2,
    });

    const provider = new MemoryTopicFamiliarityProvider(memory);
    const result = await provider.getTopicFamiliarity({
      actor: PLAYER,
      topic: 'reputation',
    });
    expect(result).toMatchObject({
      topic: 'reputation',
      level: 'FAMILIAR',
      confidence: 0.72,
      basis: ['CURRENT_MEMORY'],
    });

    await memory.markStale(familiarityRef(PLAYER, 'reputation'), {
      reason: 'test stale',
      authority: 'test',
    });
    const stale = await provider.getTopicFamiliarity({
      actor: PLAYER,
      topic: 'reputation',
    });
    expect(stale.level).toBe('UNKNOWN');
    memory.close();
  });

  it('does not repurpose staff-only memory as player familiarity', async () => {
    const memory = new MemoryService();
    await seed(
      memory,
      {
        level: 'EXPERT',
        confidence: 1,
        verifiedHelpCount: 0,
      },
      Visibility.STAFF,
    );
    const provider = new MemoryTopicFamiliarityProvider(memory);
    const result = await provider.getTopicFamiliarity({
      actor: PLAYER,
      topic: 'reputation',
    });
    expect(result.level).toBe('UNKNOWN');

    const recorder = new VerifiedHelpFamiliarityRecorder(memory);
    await recorder.record(event());
    expect(memory.getCurrent(familiarityRef(PLAYER, 'reputation'))?.key.visibility)
      .toBe(Visibility.STAFF);
    memory.close();
  });
});

describe('verified-help familiarity learning', () => {
  it('uses conservative confidence for first help and raises it after repetition', async () => {
    const memory = new MemoryService();
    const recorder = new VerifiedHelpFamiliarityRecorder(memory);
    const ref = familiarityRef(PLAYER, 'reputation');

    await recorder.record(event());
    expect(memory.getCurrent(ref)?.revision.value).toEqual({
      level: 'FAMILIAR',
      confidence: 0.5,
      verifiedHelpCount: 1,
    });

    await recorder.record(event({
      traceId: '223e4567-e89b-42d3-a456-426614174000',
      observedAt: '2026-10-07T06:00:00.000Z',
    }));
    expect(memory.getCurrent(ref)?.revision.value).toEqual({
      level: 'FAMILIAR',
      confidence: 0.7,
      verifiedHelpCount: 2,
    });

    await recorder.record(event({
      traceId: '323e4567-e89b-42d3-a456-426614174000',
      observedAt: '2026-10-08T06:00:00.000Z',
    }));
    expect(memory.getCurrent(ref)?.revision.value).toEqual({
      level: 'FAMILIAR',
      confidence: 0.85,
      verifiedHelpCount: 3,
    });

    const before = memory.getCurrent(ref)?.revision.id;
    await recorder.record(event({
      traceId: '423e4567-e89b-42d3-a456-426614174000',
      observedAt: '2026-10-09T06:00:00.000Z',
    }));
    expect(memory.getCurrent(ref)?.revision.id).toBe(before);
    memory.close();
  });

  it('never downgrades an explicit EXPERT signal', async () => {
    const memory = new MemoryService();
    const current = await seed(memory, {
      level: 'EXPERT',
      confidence: 0.95,
      verifiedHelpCount: 0,
    });
    const recorder = new VerifiedHelpFamiliarityRecorder(memory);
    await recorder.record(event());
    expect(memory.getCurrent(familiarityRef(PLAYER, 'reputation'))?.revision.id)
      .toBe(current.revision.id);
    memory.close();
  });

  it('stores bounded provenance without raw conversation text', async () => {
    const memory = new MemoryService();
    const recorder = new VerifiedHelpFamiliarityRecorder(memory);
    await recorder.record(event());
    const current = memory.getCurrent(familiarityRef(PLAYER, 'reputation'));
    expect(current?.revision.evidence).toHaveLength(1);
    expect(current?.revision.evidence[0]).toMatchObject({
      sourceArtifactId: 'conversation:discord:guild:ticket-1',
      sourceVersion: '123e4567-e89b-42d3-a456-426614174000',
      evidenceRole: EvidenceRole.SUPPORTING,
    });
    expect(JSON.stringify(current)).not.toContain('What is Good Stall');
    memory.close();
  });
});

describe('familiarity runtime composition', () => {
  it('registers nothing when no memory path is configured', () => {
    const runtime = loadConfiguredFamiliarityRuntime(undefined);
    expect(runtime.tools).toEqual([]);
    expect(runtime.onVerifiedTopicHelp).toBeUndefined();
    runtime.close();
  });

  it('registers only the subject-bound familiarity tool when configured', () => {
    const runtime = loadConfiguredFamiliarityRuntime(':memory:');
    expect(runtime.tools.map((tool) => tool.meta.name)).toEqual([
      'player.topic_familiarity',
    ]);
    expect(runtime.onVerifiedTopicHelp).toBeTypeOf('function');
    runtime.close();
  });

  it('canonicalizes safe topic names and rejects uncontrolled values', () => {
    expect(canonicalTopic('  Reputation   System ')).toBe('reputation system');
    expect(() => canonicalTopic('')).toThrow('invalid familiarity topic');
    expect(() => canonicalTopic('bad\0control')).toThrow('invalid familiarity topic');
  });
});
