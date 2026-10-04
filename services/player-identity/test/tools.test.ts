/**
 * Orchestrator tool tests (W11). Mock data only — no real inference, no production data.
 *
 * Verifies the identity tools' §16.2 provenance envelope, privacySensitive
 * metadata, and visibility enforcement through the tool-call path.
 */
import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import type { Actor } from '@enthusia/contracts';
import {
  IdentityContextTool,
  IdentityResolveTool,
  requesterFromActor,
} from '../src/index.js';
import type { IdentityContextParams, ToolCallContext } from '../src/index.js';
import { MOCK_STEVE, seededStore } from './mocks.js';

function ctxFor(actor: Actor, visibilityCeiling: Visibility): ToolCallContext {
  return { traceId: 'trace-test-1', actor, visibilityCeiling };
}

const STEVE_ACTOR: Actor = {
  id: MOCK_STEVE.discordId,
  type: 'player',
  displayName: 'MockSteve',
  linkedUuid: MOCK_STEVE.minecraftUuid,
};
const OTHER_PLAYER_ACTOR: Actor = { id: '100000000000000003', type: 'player' };
const STAFF_ACTOR: Actor = { id: 'staff-1', type: 'staff', displayName: 'MockMod' };

describe('identity.resolve tool', () => {
  it('declares privacy-sensitive metadata with PLAYER_SELF max visibility', async () => {
    const tool = new IdentityResolveTool(await seededStore());
    expect(tool.meta.name).toBe('identity.resolve');
    expect(tool.meta.verificationTier).toBe('A');
    expect(tool.meta.privacySensitive).toBe(true);
    expect(tool.meta.maxVisibility).toBe(Visibility.PLAYER_SELF);
  });

  it('resolves for the subject and carries §16.2 provenance', async () => {
    const tool = new IdentityResolveTool(await seededStore());
    const result = await tool.execute(
      { discordId: MOCK_STEVE.discordId },
      ctxFor(STEVE_ACTOR, Visibility.PLAYER_SELF),
    );
    expect(result.error).toBeUndefined();
    expect(result.toolName).toBe('identity.resolve');
    expect(result.source).toBe('player-identity');
    expect(result.visibility).toBe(Visibility.PLAYER_SELF);
    expect(result.correlationId).toBe('trace-test-1');
    expect(typeof result.timestamp).toBe('string');
    const freshness = JSON.parse(result.freshness ?? '{}') as Record<string, unknown>;
    expect(freshness['sourceStatus']).toBe('CURRENT');
    expect(freshness['observedTime']).toBe(result.timestamp);
    const payload = result.result as { minecraftUuid: string; minecraftName: string };
    expect(payload.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
    expect(payload.minecraftName).toBe('MockSteve');
  });

  it('denies an unrelated player through the tool path', async () => {
    const tool = new IdentityResolveTool(await seededStore());
    const result = await tool.execute(
      { discordId: MOCK_STEVE.discordId },
      ctxFor(OTHER_PLAYER_ACTOR, Visibility.PLAYER_SELF),
    );
    expect(result.result).toBeUndefined();
    expect(result.error?.code).toBe('visibility_denied');
    expect(result.error?.retryable).toBe(false);
  });

  it('denies under a PUBLIC visibility ceiling', async () => {
    const tool = new IdentityResolveTool(await seededStore());
    const result = await tool.execute(
      { discordId: MOCK_STEVE.discordId },
      ctxFor(STEVE_ACTOR, Visibility.PUBLIC),
    );
    expect(result.error?.code).toBe('visibility_denied');
  });

  it('allows staff through the tool path', async () => {
    const tool = new IdentityResolveTool(await seededStore());
    const result = await tool.execute(
      { username: 'MockSteve' },
      ctxFor(STAFF_ACTOR, Visibility.STAFF),
    );
    expect(result.error).toBeUndefined();
    expect((result.result as { minecraftName: string }).minecraftName).toBe('MockSteve');
  });

  it('returns not_found for unknown identifiers, invalid_input when empty', async () => {
    const tool = new IdentityResolveTool(await seededStore());
    const missing = await tool.execute({ discordId: '999999999999999999' }, ctxFor(STAFF_ACTOR, Visibility.STAFF));
    expect(missing.error?.code).toBe('not_found');
    const empty = await tool.execute({}, ctxFor(STAFF_ACTOR, Visibility.STAFF));
    expect(empty.error?.code).toBe('invalid_input');
  });

  it('rejects conflicting identity selectors instead of silently choosing one', async () => {
    const tool = new IdentityResolveTool(await seededStore());
    const result = await tool.execute(
      { discordId: MOCK_STEVE.discordId, username: 'MockSteve' },
      ctxFor(STAFF_ACTOR, Visibility.STAFF),
    );
    expect(result.error?.code).toBe('invalid_input');
    expect(result.result).toBeUndefined();
  });

  it('error messages never echo private payloads', async () => {
    const tool = new IdentityResolveTool(await seededStore());
    const result = await tool.execute(
      { discordId: MOCK_STEVE.discordId },
      ctxFor(OTHER_PLAYER_ACTOR, Visibility.PLAYER_SELF),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(MOCK_STEVE.minecraftUuid);
  });
});

describe('identity.context tool', () => {
  it('declares privacy-sensitive metadata and requires a purpose', async () => {
    const tool = new IdentityContextTool(await seededStore());
    expect(tool.meta.name).toBe('identity.context');
    expect(tool.meta.privacySensitive).toBe(true);
    expect(tool.meta.maxVisibility).toBe(Visibility.PLAYER_SELF);
    expect(tool.meta.parameters.required).toContain('purpose');
    expect(tool.meta.parameters.properties['purpose']?.enum).toContain('rank-question');
  });

  it('returns relevance-scoped context for a rank question', async () => {
    const tool = new IdentityContextTool(await seededStore());
    const result = await tool.execute(
      { discordId: MOCK_STEVE.discordId, purpose: 'rank-question' },
      ctxFor(STEVE_ACTOR, Visibility.PLAYER_SELF),
    );
    expect(result.error).toBeUndefined();
    const context = result.result as {
      purpose: string;
      fields: Record<string, unknown>;
      withheld: unknown[];
    };
    expect(context.purpose).toBe('rank-question');
    expect((context.fields['ranks'] as { primaryGroup: string }).primaryGroup).toBe('devotee');
    expect('nameHistory' in context.fields).toBe(false);
  });

  it('rejects conflicting selectors for contextual lookup', async () => {
    const tool = new IdentityContextTool(await seededStore());
    const result = await tool.execute(
      {
        discordId: MOCK_STEVE.discordId,
        minecraftUuid: MOCK_STEVE.minecraftUuid,
        purpose: 'rank-question',
      },
      ctxFor(STAFF_ACTOR, Visibility.STAFF),
    );
    expect(result.error?.code).toBe('invalid_input');
    expect(result.result).toBeUndefined();
  });

  it('rejects unknown purposes', async () => {
    const tool = new IdentityContextTool(await seededStore());
    const result = await tool.execute(
      {
        discordId: MOCK_STEVE.discordId,
        purpose: 'read-their-diary' as unknown as IdentityContextParams['purpose'],
      },
      ctxFor(STAFF_ACTOR, Visibility.STAFF),
    );
    expect(result.error?.code).toBe('invalid_input');
  });
});

describe('requesterFromActor', () => {
  it('maps a player actor with a Discord snowflake id to the subject', () => {
    const requester = requesterFromActor(STEVE_ACTOR);
    expect(requester.discordId).toBe(MOCK_STEVE.discordId);
    expect(requester.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
    expect(requester.isStaff).toBe(false);
  });

  it('maps a UUID actor id to minecraftUuid', () => {
    const requester = requesterFromActor({ id: MOCK_STEVE.minecraftUuid, type: 'player' });
    expect(requester.discordId).toBeUndefined();
    expect(requester.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
  });

  it('marks staff actors', () => {
    expect(requesterFromActor(STAFF_ACTOR).isStaff).toBe(true);
  });
});
