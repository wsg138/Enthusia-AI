import { describe, expect, it } from 'vitest';
import {
  EvidenceRole,
  Visibility,
  type Actor,
} from '@enthusia/contracts';
import {
  extractClaimEvidence,
  isCurrentEvidence,
  type ToolCallContext,
} from '@enthusia/agent-core';
import { MemoryService } from '@enthusia/memory';
import { PublicCurrentMemoryTool } from '../src/current-memory.js';

const ACTOR: Actor = {
  id: 'player-1',
  type: 'player',
};

function context(
  overrides: Partial<ToolCallContext> = {},
): ToolCallContext {
  return {
    traceId: '123e4567-e89b-42d3-a456-426614174000',
    actor: ACTOR,
    visibilityCeiling: Visibility.PUBLIC,
    ...overrides,
  };
}

function seedPublic(
  memory: MemoryService,
  options: {
    visibility?: Visibility;
    evidence?: boolean;
    value?: unknown;
  } = {},
) {
  return memory.createRevision({
    namespace: 'network',
    key: 'connection.ip',
    scope: 'global',
    visibility: options.visibility ?? Visibility.PUBLIC,
    value: options.value ?? 'play.enthusia.gg',
    summary: 'Current public server connection address.',
    authority: 'indexer',
    evidence: options.evidence === false
      ? []
      : [{
          sourceArtifactId: 'live:network-config',
          sourceVersion: 'sha-test-current',
          evidenceRole: EvidenceRole.PRIMARY,
          observedAt: '2026-10-07T12:00:00.000Z',
          verifiedAt: '2026-10-07T12:00:00.000Z',
        }],
  });
}

describe('memory.current_fact', () => {
  it('returns exact evidence-backed PUBLIC CURRENT memory as tier-C claim evidence', async () => {
    const memory = new MemoryService();
    try {
      const created = await seedPublic(memory);
      const tool = new PublicCurrentMemoryTool(memory);
      const result = await tool.execute({
        namespace: 'network',
        key: 'connection.ip',
        scope: 'global',
      }, context());

      expect(result.error).toBeUndefined();
      expect(result.visibility).toBe(Visibility.PUBLIC);
      expect(result.result).toEqual({
        value: 'play.enthusia.gg',
        excerpt: 'Current public server connection address.',
        memory: {
          keyId: created.key.id,
          namespace: 'network',
          key: 'connection.ip',
          scope: 'global',
          status: 'CURRENT',
        },
      });
      expect(isCurrentEvidence(result, 'C')).toBe(true);

      const evidence = extractClaimEvidence(
        'e1',
        'server address',
        tool.meta.name,
        result,
        'C',
      );
      expect(evidence).toMatchObject({
        value: 'play.enthusia.gg',
        current: true,
        verificationTier: 'C',
        memory: {
          keyId: created.key.id,
          namespace: 'network',
          key: 'connection.ip',
          scope: 'global',
          status: 'CURRENT',
        },
      });
    } finally {
      memory.close();
    }
  });

  it('does not disclose STAFF memory through the public exact-key surface', async () => {
    const memory = new MemoryService();
    try {
      await seedPublic(memory, { visibility: Visibility.STAFF });
      const tool = new PublicCurrentMemoryTool(memory);
      const result = await tool.execute({
        namespace: 'network',
        key: 'connection.ip',
        scope: 'global',
      }, context({ actor: { id: 'staff-1', type: 'staff' } }));

      expect(result.result).toBeUndefined();
      expect(result.error).toMatchObject({
        code: 'public_memory_unavailable',
        retryable: false,
      });
      expect(result.error?.message).not.toMatch(/staff|private|exists/i);
    } finally {
      memory.close();
    }
  });

  it('fails closed when a CURRENT record has no provenance evidence', async () => {
    const memory = new MemoryService();
    try {
      await seedPublic(memory, { evidence: false });
      const tool = new PublicCurrentMemoryTool(memory);
      const result = await tool.execute({
        namespace: 'network',
        key: 'connection.ip',
        scope: 'global',
      }, context());

      expect(result.result).toBeUndefined();
      expect(result.error?.code).toBe('public_memory_unavailable');
      expect(isCurrentEvidence(result, 'C')).toBe(false);
    } finally {
      memory.close();
    }
  });

  it('does not return STALE or missing memory as current truth', async () => {
    const memory = new MemoryService();
    try {
      await seedPublic(memory);
      await memory.markStale({
        namespace: 'network',
        key: 'connection.ip',
        scope: 'global',
      }, {
        reason: 'live source changed',
        authority: 'indexer',
      });
      const tool = new PublicCurrentMemoryTool(memory);

      const stale = await tool.execute({
        namespace: 'network',
        key: 'connection.ip',
        scope: 'global',
      }, context());
      const missing = await tool.execute({
        namespace: 'network',
        key: 'missing',
        scope: 'global',
      }, context());

      expect(stale.error?.code).toBe('public_memory_unavailable');
      expect(missing.error?.code).toBe('public_memory_unavailable');
      expect(stale.result).toBeUndefined();
      expect(missing.result).toBeUndefined();
    } finally {
      memory.close();
    }
  });

  it('rejects uncontrolled identity values and oversized fact payloads', async () => {
    const memory = new MemoryService();
    try {
      await seedPublic(memory, { value: 'x'.repeat(2_001) });
      const tool = new PublicCurrentMemoryTool(memory);

      const invalid = await tool.execute({
        namespace: 'network\u0000bad',
        key: 'connection.ip',
        scope: 'global',
      }, context());
      const oversized = await tool.execute({
        namespace: 'network',
        key: 'connection.ip',
        scope: 'global',
      }, context());

      expect(invalid.error?.code).toBe('invalid_memory_ref');
      expect(oversized.error?.code).toBe('public_memory_unavailable');
    } finally {
      memory.close();
    }
  });
});
