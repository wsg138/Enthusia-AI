/**
 * Resolution + visibility enforcement tests (W11). Mock data only.
 *
 * Key principle under test: the identity linkage is PLAYER_SELF — visible
 * to the player themselves and authorized staff, never PUBLIC, and never
 * to an unrelated player.
 */
import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import { PlayerIdentityService } from '../src/index.js';
import {
  ALEX_OTHER,
  ANONYMOUS,
  MOCK_MOD,
  MOCK_STEVE,
  MOD_STAFF,
  STEVE_SELF,
  seededStore,
} from './mocks.js';

describe('resolveByDiscordId', () => {
  it('resolves Discord ID → UUID + current username + rank (acceptance)', async () => {
    const service = new PlayerIdentityService(await seededStore());
    const resolved = await service.resolveByDiscordId(MOCK_STEVE.discordId, STEVE_SELF);
    expect(resolved.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
    expect(resolved.minecraftName).toBe('MockSteve');
    expect(resolved.ranks.primaryGroup).toBe('devotee');
    expect(resolved.visibility).toBe(Visibility.PLAYER_SELF);
  });

  it('resolves by UUID and by username too', async () => {
    const service = new PlayerIdentityService(await seededStore());
    const byUuid = await service.resolveByUuid(MOCK_MOD.minecraftUuid, MOD_STAFF);
    expect(byUuid.minecraftName).toBe('MockMod');
    expect(byUuid.ranks.staffRole).toBe('Mod');
    const byName = await service.resolveByUsername('MockSteve', MOD_STAFF);
    expect(byName.discordId).toBe(MOCK_STEVE.discordId);
  });

  it('re-reads current rank state on each resolution', async () => {
    const store = await seededStore();
    const service = new PlayerIdentityService(store);
    const before = await service.resolveByDiscordId(MOCK_STEVE.discordId, STEVE_SELF);
    expect(before.ranks.primaryGroup).toBe('devotee');
    await store.setRanks(MOCK_STEVE.minecraftUuid, {
      primaryGroup: 'avid',
      groups: ['avid', 'default'],
      donorRank: 'Avid',
    });
    const after = await service.resolveByDiscordId(MOCK_STEVE.discordId, STEVE_SELF);
    expect(after.ranks.primaryGroup).toBe('avid');
  });

  it('staff can resolve another player', async () => {
    const service = new PlayerIdentityService(await seededStore());
    const resolved = await service.resolveByDiscordId(MOCK_STEVE.discordId, MOD_STAFF);
    expect(resolved.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
  });

  it('denies an unrelated player (PLAYER_SELF enforcement)', async () => {
    const service = new PlayerIdentityService(await seededStore());
    await expect(service.resolveByDiscordId(MOCK_STEVE.discordId, ALEX_OTHER)).rejects.toMatchObject({
      code: 'visibility_denied',
    });
  });

  it('denies an anonymous requester', async () => {
    const service = new PlayerIdentityService(await seededStore());
    await expect(service.resolveByDiscordId(MOCK_STEVE.discordId, ANONYMOUS)).rejects.toMatchObject({
      code: 'visibility_denied',
    });
  });

  it('denies when the visibility ceiling is PUBLIC', async () => {
    const service = new PlayerIdentityService(await seededStore());
    // Even the subject cannot pull PLAYER_SELF linkage under a PUBLIC ceiling.
    await expect(
      service.resolveByDiscordId(MOCK_STEVE.discordId, STEVE_SELF, Visibility.PUBLIC),
    ).rejects.toMatchObject({ code: 'visibility_denied' });
    await expect(
      service.resolveByDiscordId(MOCK_STEVE.discordId, MOD_STAFF, Visibility.PUBLIC),
    ).rejects.toMatchObject({ code: 'visibility_denied' });
  });

  it('throws not_found for unknown identifiers', async () => {
    const service = new PlayerIdentityService(await seededStore());
    await expect(
      service.resolveByDiscordId('999999999999999999', MOD_STAFF),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a staff requester is identified via isStaff even without matching IDs', async () => {
    const service = new PlayerIdentityService(await seededStore());
    const staffWithoutLink = { isStaff: true };
    const resolved = await service.resolveByDiscordId(MOCK_STEVE.discordId, staffWithoutLink);
    expect(resolved.minecraftName).toBe('MockSteve');
  });
});

describe('link/unlink authorization', () => {
  it('staff can link a new identity', async () => {
    const service = new PlayerIdentityService(await seededStore());
    const resolved = await service.linkIdentity(
      MOD_STAFF,
      '100000000000000010',
      '12345678-1234-4234-8234-123456789abc',
      'FreshMock',
    );
    expect(resolved.minecraftName).toBe('FreshMock');
  });

  it('a player can self-link their own Discord ID', async () => {
    const service = new PlayerIdentityService(await seededStore());
    const selfLinker = { discordId: '100000000000000010', isStaff: false };
    const resolved = await service.linkIdentity(
      selfLinker,
      '100000000000000010',
      '12345678-1234-4234-8234-123456789abc',
      'FreshMock',
    );
    expect(resolved.discordId).toBe('100000000000000010');
  });

  it('a non-staff player cannot link someone else', async () => {
    const service = new PlayerIdentityService(await seededStore());
    await expect(
      service.linkIdentity(
        ALEX_OTHER,
        '100000000000000010',
        '12345678-1234-4234-8234-123456789abc',
        'FreshMock',
      ),
    ).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('unlink and rank updates are staff-only', async () => {
    const service = new PlayerIdentityService(await seededStore());
    await expect(service.unlinkIdentity(ALEX_OTHER, MOCK_STEVE.discordId)).rejects.toMatchObject({
      code: 'not_authorized',
    });
    await expect(
      service.setRanks(ALEX_OTHER, MOCK_STEVE.minecraftUuid, {
        primaryGroup: 'default',
        groups: ['default'],
      }),
    ).rejects.toMatchObject({ code: 'not_authorized' });
    expect(await service.unlinkIdentity(MOD_STAFF, MOCK_STEVE.discordId)).toBe(true);
  });
});
