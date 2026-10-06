import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import type { Actor } from '@enthusia/contracts';
import {
  TopicFamiliarityTool,
  type TopicFamiliarityProvider,
} from '../src/index.js';

const PLAYER: Actor = {
  id: '100000000000000001',
  type: 'player',
  displayName: 'PlayerOne',
  linkedUuid: '123e4567-e89b-12d3-a456-426614174000',
};

function provider(
  level: 'NEW' | 'FAMILIAR' | 'EXPERT' | 'UNKNOWN' = 'FAMILIAR',
): TopicFamiliarityProvider {
  return {
    async getTopicFamiliarity(input) {
      return {
        topic: input.topic,
        level,
        confidence: 0.8,
        basis: ['CURRENT_MEMORY'],
        observedAt: '2026-10-06T05:00:00.000Z',
      };
    },
  };
}

describe('player.topic_familiarity', () => {
  it('is privacy-sensitive, subject-bound, and exposes no player selector', () => {
    const tool = new TopicFamiliarityTool(provider());
    expect(tool.meta.name).toBe('player.topic_familiarity');
    expect(tool.meta.privacySensitive).toBe(true);
    expect(tool.meta.maxVisibility).toBe(Visibility.PLAYER_SELF);
    expect(tool.meta.parameters.required).toEqual(['topic']);
    expect(Object.keys(tool.meta.parameters.properties)).toEqual(['topic']);
  });

  it('returns only the compact response-style signal for the current player', async () => {
    let seenActor: Actor | undefined;
    const tool = new TopicFamiliarityTool({
      async getTopicFamiliarity(input) {
        seenActor = input.actor;
        return {
          topic: 'provider-cannot-change-topic',
          level: 'EXPERT',
          confidence: 0.95,
          basis: ['CURRENT_CONTEXT', 'CONVERSATION'],
          observedAt: '2026-10-06T05:00:00.000Z',
        };
      },
    });

    const result = await tool.execute(
      { topic: '  reputation   system ' },
      {
        traceId: 'trace-familiarity-1',
        actor: PLAYER,
        visibilityCeiling: Visibility.PLAYER_SELF,
      },
    );

    expect(seenActor?.id).toBe(PLAYER.id);
    expect(result.error).toBeUndefined();
    expect(result.visibility).toBe(Visibility.PLAYER_SELF);
    expect(result.source).toBe('player-context');
    expect(result.result).toEqual({
      topic: 'reputation system',
      level: 'EXPERT',
      confidence: 0.95,
      basis: ['CURRENT_CONTEXT', 'CONVERSATION'],
      observedAt: '2026-10-06T05:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('provider-cannot-change-topic');
  });

  it('fails closed below PLAYER_SELF visibility', async () => {
    const tool = new TopicFamiliarityTool(provider());
    const result = await tool.execute(
      { topic: 'reputation' },
      {
        traceId: 'trace-familiarity-2',
        actor: PLAYER,
        visibilityCeiling: Visibility.PUBLIC,
      },
    );
    expect(result.result).toBeUndefined();
    expect(result.error?.code).toBe('visibility_denied');
  });

  it('does not turn staff/system actors into arbitrary player lookups', async () => {
    const tool = new TopicFamiliarityTool(provider());
    const result = await tool.execute(
      { topic: 'events' },
      {
        traceId: 'trace-familiarity-3',
        actor: { id: 'staff-1', type: 'staff' },
        visibilityCeiling: Visibility.STAFF,
      },
    );
    expect(result.result).toBeUndefined();
    expect(result.error?.code).toBe('not_authorized');
  });

  it('rejects malformed provider output without exposing it', async () => {
    const secretText = 'private support note that must never reach the model';
    const tool = new TopicFamiliarityTool({
      async getTopicFamiliarity() {
        return {
          topic: secretText,
          level: 'FAMILIAR',
          confidence: 8,
          basis: ['CURRENT_MEMORY'],
          observedAt: 'not-a-date',
        };
      },
    });

    const result = await tool.execute(
      { topic: 'mail' },
      {
        traceId: 'trace-familiarity-4',
        actor: PLAYER,
        visibilityCeiling: Visibility.PLAYER_SELF,
      },
    );

    expect(result.result).toBeUndefined();
    expect(result.error?.code).toBe('familiarity_unavailable');
    expect(JSON.stringify(result)).not.toContain(secretText);
  });

  it('rejects blank topics deterministically', async () => {
    const tool = new TopicFamiliarityTool(provider('UNKNOWN'));
    const result = await tool.execute(
      { topic: '   ' },
      {
        traceId: 'trace-familiarity-5',
        actor: PLAYER,
        visibilityCeiling: Visibility.PLAYER_SELF,
      },
    );
    expect(result.error?.code).toBe('familiarity_unavailable');
    expect(result.error?.retryable).toBe(false);
  });
});
