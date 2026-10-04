/**
 * Mock identity fixtures for player-identity tests (W11).
 *
 * ALL DATA IS FICTIONAL. These are synthetic players invented for tests —
 * no real Discord IDs, Minecraft UUIDs, or usernames appear here. The
 * snowflakes below are obviously fake (10000000000000000x) and the UUIDs
 * are fixed v4 values that belong to nobody.
 */
import type { IdentityRequester, PlayerIdentity } from '../src/index.js';
import { InMemoryIdentityStore } from '../src/index.js';

export const MOCK_STEVE: PlayerIdentity = {
  discordId: '100000000000000001',
  minecraftUuid: '11111111-2222-4333-8444-555555555555',
  minecraftName: 'MockSteve',
  nameHistory: [
    { name: 'OldMockSteve', changedAt: '2025-06-01T12:00:00.000Z' },
  ],
  bedrock: { gamerTag: 'MockSteveBE', xuid: '1600000000000001' },
  ranks: {
    primaryGroup: 'devotee',
    groups: ['devotee', 'default'],
    donorRank: 'Devotee',
  },
  updatedAt: '2026-10-01T00:00:00.000Z',
};

export const MOCK_MOD: PlayerIdentity = {
  discordId: '100000000000000002',
  minecraftUuid: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  minecraftName: 'MockMod',
  nameHistory: [],
  ranks: {
    primaryGroup: 'mod',
    groups: ['mod', 'default'],
    staffRole: 'Mod',
  },
  updatedAt: '2026-10-01T00:00:00.000Z',
};

export const MOCK_ALEX: PlayerIdentity = {
  discordId: '100000000000000003',
  minecraftUuid: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  minecraftName: 'MockAlex',
  nameHistory: [],
  ranks: {
    primaryGroup: 'default',
    groups: ['default'],
  },
  updatedAt: '2026-10-01T00:00:00.000Z',
};

/** Store pre-seeded with the three mock players. */
export async function seededStore(): Promise<InMemoryIdentityStore> {
  const store = new InMemoryIdentityStore();
  await store.upsert(MOCK_STEVE);
  await store.upsert(MOCK_MOD);
  await store.upsert(MOCK_ALEX);
  return store;
}

/** Requester viewing as MockSteve themselves (not staff). */
export const STEVE_SELF: IdentityRequester = {
  discordId: MOCK_STEVE.discordId,
  minecraftUuid: MOCK_STEVE.minecraftUuid,
  isStaff: false,
};

/** Requester viewing as MockMod, who is staff. */
export const MOD_STAFF: IdentityRequester = {
  discordId: MOCK_MOD.discordId,
  minecraftUuid: MOCK_MOD.minecraftUuid,
  isStaff: true,
};

/** Unrelated regular player (MockAlex) — neither subject nor staff. */
export const ALEX_OTHER: IdentityRequester = {
  discordId: MOCK_ALEX.discordId,
  minecraftUuid: MOCK_ALEX.minecraftUuid,
  isStaff: false,
};

/** Anonymous/unknown requester. */
export const ANONYMOUS: IdentityRequester = { isStaff: false };
