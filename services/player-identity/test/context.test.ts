/**
 * Relevance-based context tests (W11, spec §68). Mock data only.
 *
 * The core guarantee: `getRelevantContext(purpose)` returns ONLY what the
 * purpose needs and visibility allows. Unrelated private history is never
 * fetched merely because the service can.
 */
import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import { PlayerIdentityService } from '../src/index.js';
import {
  ALEX_OTHER,
  MOCK_MOD,
  MOCK_STEVE,
  MOD_STAFF,
  STEVE_SELF,
  seededStore,
} from './mocks.js';

async function service() {
  return new PlayerIdentityService(await seededStore());
}

describe('getRelevantContext', () => {
  it('rank question: role/rank context relevant, private history NOT fetched', async () => {
    const svc = await service();
    const identity = (await (await seededStore()).findByDiscordId(MOCK_STEVE.discordId))!;
    const ctx = await svc.getRelevantContext(identity, 'rank-question', STEVE_SELF, Visibility.PLAYER_SELF);

    expect(ctx.purpose).toBe('rank-question');
    expect(ctx.subject.minecraftName).toBe('MockSteve');
    expect(ctx.fields.ranks?.primaryGroup).toBe('devotee');
    expect(ctx.fields.minecraftName).toBe('MockSteve');
    // Private history is not relevant to a rank question: absent entirely,
    // not even listed as withheld (it was never fetched).
    expect('nameHistory' in ctx.fields).toBe(false);
    expect('bedrock' in ctx.fields).toBe(false);
    expect(ctx.withheld.find((w) => w.field === 'nameHistory')).toBeUndefined();
    expect(ctx.withheld.find((w) => w.field === 'bedrock')).toBeUndefined();
  });

  it('server IP question: private history irrelevant', async () => {
    const svc = await service();
    const identity = (await (await seededStore()).findByDiscordId(MOCK_STEVE.discordId))!;
    const ctx = await svc.getRelevantContext(identity, 'server-info', STEVE_SELF, Visibility.PLAYER_SELF);

    expect(Object.keys(ctx.fields)).toEqual(['minecraftName']);
    expect(ctx.withheld).toEqual([]);
  });

  it('ticket support: linkage relevant, private history NOT fetched by default', async () => {
    const svc = await service();
    const identity = (await (await seededStore()).findByDiscordId(MOCK_STEVE.discordId))!;
    // Staff handling a ticket for the player.
    const ctx = await svc.getRelevantContext(identity, 'ticket-support', MOD_STAFF, Visibility.PLAYER_SELF);

    expect(ctx.fields.discordId).toBe(MOCK_STEVE.discordId);
    expect(ctx.fields.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
    // Even for authorized staff, the ticket-support purpose does not pull
    // private username/bedrock history — that is "unrelated private history".
    expect('nameHistory' in ctx.fields).toBe(false);
    expect('bedrock' in ctx.fields).toBe(false);
    expect('ranks' in ctx.fields).toBe(false);
  });

  it('moderation purpose (staff): full identity including private history', async () => {
    const svc = await service();
    const identity = (await (await seededStore()).findByDiscordId(MOCK_STEVE.discordId))!;
    const ctx = await svc.getRelevantContext(identity, 'moderation', MOD_STAFF, Visibility.PLAYER_SELF);

    expect(ctx.fields.nameHistory).toHaveLength(1);
    expect(ctx.fields.nameHistory?.[0]?.name).toBe('OldMockSteve');
    expect(ctx.fields.bedrock?.gamerTag).toBe('MockSteveBE');
    expect(ctx.fields.ranks?.primaryGroup).toBe('devotee');
    expect(ctx.withheld).toEqual([]);
  });

  it('moderation purpose (non-staff): PLAYER_SELF fields withheld with reasons', async () => {
    const svc = await service();
    const identity = (await (await seededStore()).findByDiscordId(MOCK_STEVE.discordId))!;
    const ctx = await svc.getRelevantContext(identity, 'moderation', ALEX_OTHER, Visibility.PLAYER_SELF);

    // Only the PUBLIC field survives.
    expect(ctx.fields.minecraftName).toBe('MockSteve');
    expect('nameHistory' in ctx.fields).toBe(false);
    expect('ranks' in ctx.fields).toBe(false);
    const withheldFields = ctx.withheld.map((w) => w.field);
    expect(withheldFields).toContain('nameHistory');
    expect(withheldFields).toContain('ranks');
    expect(withheldFields).toContain('discordId');
    for (const w of ctx.withheld) {
      expect(w.reason).toContain('PLAYER_SELF');
    }
  });

  it('unrelated player asking a rank question about someone else gets no rank', async () => {
    const svc = await service();
    const identity = (await (await seededStore()).findByDiscordId(MOCK_MOD.discordId))!;
    const ctx = await svc.getRelevantContext(identity, 'rank-question', ALEX_OTHER, Visibility.PLAYER_SELF);

    expect('ranks' in ctx.fields).toBe(false);
    expect(ctx.withheld.find((w) => w.field === 'ranks')).toBeDefined();
    // Public username is still fine.
    expect(ctx.fields.minecraftName).toBe('MockMod');
  });

  it('PUBLIC ceiling strips PLAYER_SELF fields even for the subject', async () => {
    const svc = await service();
    const identity = (await (await seededStore()).findByDiscordId(MOCK_STEVE.discordId))!;
    const ctx = await svc.getRelevantContext(identity, 'rank-question', STEVE_SELF, Visibility.PUBLIC);

    expect(ctx.fields.minecraftName).toBe('MockSteve');
    expect('ranks' in ctx.fields).toBe(false);
    expect(ctx.withheld.find((w) => w.field === 'ranks')?.reason).toContain('ceiling');
  });

  it('general purpose returns public info only', async () => {
    const svc = await service();
    const identity = (await (await seededStore()).findByDiscordId(MOCK_STEVE.discordId))!;
    const ctx = await svc.getRelevantContext(identity, 'general', ALEX_OTHER, Visibility.PUBLIC);

    expect(ctx.fields).toEqual({ minecraftName: 'MockSteve' });
    expect(ctx.withheld).toEqual([]);
  });

  it('identity-linkage purpose exposes the mapping to subject/staff only', async () => {
    const svc = await service();
    const identity = (await (await seededStore()).findByDiscordId(MOCK_STEVE.discordId))!;

    const asSubject = await svc.getRelevantContext(identity, 'identity-linkage', STEVE_SELF, Visibility.PLAYER_SELF);
    expect(asSubject.fields.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
    expect(asSubject.fields.discordId).toBe(MOCK_STEVE.discordId);

    const asOther = await svc.getRelevantContext(identity, 'identity-linkage', ALEX_OTHER, Visibility.PLAYER_SELF);
    expect('minecraftUuid' in asOther.fields).toBe(false);
    expect('discordId' in asOther.fields).toBe(false);
    expect(asOther.withheld).toHaveLength(2);
  });

  it('permission-check purpose: identity + rank, no private history', async () => {
    const svc = await service();
    const identity = (await (await seededStore()).findByDiscordId(MOCK_STEVE.discordId))!;
    const ctx = await svc.getRelevantContext(identity, 'permission-check', STEVE_SELF, Visibility.PLAYER_SELF);

    expect(ctx.fields.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
    expect(ctx.fields.ranks?.primaryGroup).toBe('devotee');
    expect('nameHistory' in ctx.fields).toBe(false);
  });

  it('rejects unknown purposes', async () => {
    const svc = await service();
    const identity = (await (await seededStore()).findByDiscordId(MOCK_STEVE.discordId))!;
    await expect(
      svc.getRelevantContext(identity, 'read-their-diary' as never, STEVE_SELF, Visibility.PLAYER_SELF),
    ).rejects.toThrowError(/unknown purpose/);
  });
});
