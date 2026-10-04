/**
 * Identity store tests (W11). Mock data only — no real APIs, no production data.
 */
import { describe, expect, it } from 'vitest';
import {
  IdentityStoreError,
  InMemoryIdentityStore,
} from '../src/index.js';
import { MOCK_ALEX, MOCK_STEVE, seededStore } from './mocks.js';

describe('InMemoryIdentityStore', () => {
  it('finds a linked identity by Discord ID', async () => {
    const store = await seededStore();
    const found = await store.findByDiscordId(MOCK_STEVE.discordId);
    expect(found?.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
    expect(found?.minecraftName).toBe('MockSteve');
  });

  it('finds a linked identity by UUID (case-insensitive)', async () => {
    const store = await seededStore();
    const found = await store.findByUuid(MOCK_STEVE.minecraftUuid.toUpperCase());
    expect(found?.discordId).toBe(MOCK_STEVE.discordId);
  });

  it('finds by current username and by historical username', async () => {
    const store = await seededStore();
    expect((await store.findByUsername('MockSteve'))?.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
    expect((await store.findByUsername('mocksteve'))?.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
    expect((await store.findByUsername('OldMockSteve'))?.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
    expect(await store.findByUsername('NobodyHere')).toBeUndefined();
  });

  it('never silently chooses when a historical username is reused', async () => {
    const store = await seededStore();
    await store.link(
      '100000000000000010',
      '12345678-1234-4234-8234-123456789abc',
      'OldMockSteve',
    );
    await expect(store.findByUsername('OldMockSteve')).rejects.toMatchObject({
      code: 'ambiguous',
    });
  });

  it('returns undefined for unknown identifiers', async () => {
    const store = await seededStore();
    expect(await store.findByDiscordId('999999999999999999')).toBeUndefined();
    expect(await store.findByUuid('00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('links a new Discord ID to a UUID', async () => {
    const store = new InMemoryIdentityStore();
    const identity = await store.link(
      '100000000000000010',
      '12345678-1234-4234-8234-123456789abc',
      'FreshMock',
    );
    expect(identity.minecraftName).toBe('FreshMock');
    expect(identity.ranks.primaryGroup).toBe('default');
    expect(await store.size()).toBe(1);
  });

  it('rejects linking an already-linked Discord ID to a different UUID', async () => {
    const store = await seededStore();
    await expect(
      store.link(MOCK_STEVE.discordId, '12345678-1234-4234-8234-123456789abc', 'Someone'),
    ).rejects.toMatchObject({ code: 'already_linked' });
  });

  it('rejects linking an already-linked UUID to a different Discord ID', async () => {
    const store = await seededStore();
    await expect(
      store.link('100000000000000099', MOCK_STEVE.minecraftUuid, 'Someone'),
    ).rejects.toMatchObject({ code: 'already_linked' });
  });

  it('re-linking the same pair is idempotent', async () => {
    const store = await seededStore();
    const again = await store.link(MOCK_STEVE.discordId, MOCK_STEVE.minecraftUuid, 'MockSteve');
    expect(again.minecraftUuid).toBe(MOCK_STEVE.minecraftUuid);
    expect(await store.size()).toBe(3);
  });

  it('rejects invalid identifiers on link', async () => {
    const store = new InMemoryIdentityStore();
    await expect(store.link('not-a-snowflake', MOCK_ALEX.minecraftUuid, 'MockAlex')).rejects.toBeInstanceOf(
      IdentityStoreError,
    );
    await expect(store.link('100000000000000010', 'not-a-uuid', 'MockAlex')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('unlinks a Discord ID', async () => {
    const store = await seededStore();
    expect(await store.unlink(MOCK_ALEX.discordId)).toBe(true);
    expect(await store.findByDiscordId(MOCK_ALEX.discordId)).toBeUndefined();
    expect(await store.findByUuid(MOCK_ALEX.minecraftUuid)).toBeUndefined();
    expect(await store.unlink(MOCK_ALEX.discordId)).toBe(false);
  });

  it('records username changes into history', async () => {
    const store = await seededStore();
    await store.recordUsernameChange(MOCK_ALEX.minecraftUuid, 'MockAlexTwo');
    const found = await store.findByUuid(MOCK_ALEX.minecraftUuid);
    expect(found?.minecraftName).toBe('MockAlexTwo');
    expect(found?.nameHistory).toHaveLength(1);
    expect(found?.nameHistory[0]?.name).toBe('MockAlex');
    // Old name still resolves to the same identity.
    expect((await store.findByUsername('MockAlex'))?.minecraftUuid).toBe(MOCK_ALEX.minecraftUuid);
  });

  it('case-only username changes do not create history aliases', async () => {
    const store = await seededStore();
    const before = await store.findByUuid(MOCK_ALEX.minecraftUuid);
    const historySize = before?.nameHistory.length ?? 0;
    await store.recordUsernameChange(MOCK_ALEX.minecraftUuid, 'mockalex');
    const after = await store.findByUuid(MOCK_ALEX.minecraftUuid);
    expect(after?.minecraftName).toBe('mockalex');
    expect(after?.nameHistory).toHaveLength(historySize);
    expect(await store.size()).toBe(3);
  });

  it('updates rank context', async () => {
    const store = await seededStore();
    await store.setRanks(MOCK_ALEX.minecraftUuid, {
      primaryGroup: 'avid',
      groups: ['avid', 'default'],
      donorRank: 'Avid',
    });
    const found = await store.findByUuid(MOCK_ALEX.minecraftUuid);
    expect(found?.ranks.primaryGroup).toBe('avid');
    expect(found?.ranks.donorRank).toBe('Avid');
  });

  it('sets and clears Bedrock identity', async () => {
    const store = await seededStore();
    await store.setBedrockIdentity(MOCK_ALEX.minecraftUuid, { gamerTag: 'MockAlexBE' });
    expect((await store.findByUuid(MOCK_ALEX.minecraftUuid))?.bedrock?.gamerTag).toBe('MockAlexBE');
    await store.setBedrockIdentity(MOCK_ALEX.minecraftUuid, undefined);
    expect((await store.findByUuid(MOCK_ALEX.minecraftUuid))?.bedrock).toBeUndefined();
  });

  it('throws not_found for mutations on unknown UUIDs', async () => {
    const store = await seededStore();
    const missing = '00000000-0000-4000-8000-000000000000';
    await expect(store.recordUsernameChange(missing, 'Nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      store.setRanks(missing, { primaryGroup: 'default', groups: ['default'] }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns defensive copies (mutating results does not corrupt the store)', async () => {
    const store = await seededStore();
    const found = await store.findByDiscordId(MOCK_STEVE.discordId);
    found?.nameHistory.push({ name: 'Tampered', changedAt: '2026-01-01T00:00:00.000Z' });
    if (found !== undefined) found.minecraftName = 'Tampered';
    const refetch = await store.findByDiscordId(MOCK_STEVE.discordId);
    expect(refetch?.minecraftName).toBe('MockSteve');
    expect(refetch?.nameHistory).toHaveLength(1);
  });
});
