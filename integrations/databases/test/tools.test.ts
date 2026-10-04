/**
 * @enthusia/integration-databases — happy-path tool tests (W10).
 *
 * Mock database only. Covers all five tools: success payloads, typed
 * results, and not-found behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  makeHarness,
  selfContext,
  staffContext,
  SAMPLE_UUID,
  SAMPLE_DISCORD_ID,
  OTHER_UUID,
} from './helpers.js';
import type {
  LinkedAccountResult,
  PlayerRankResult,
  PermissionStateResult,
  TicketMetadataResult,
  EconomyFactResult,
} from '../src/tools.js';

describe('db.resolve_linked_account', () => {
  it('resolves a Discord ID to the linked Minecraft account', async () => {
    const { toolset } = makeHarness();
    const tool = toolset.get('db.resolve_linked_account');
    expect(tool).toBeDefined();
    const out = await tool!.execute(
      { discordId: SAMPLE_DISCORD_ID },
      selfContext(),
    );
    expect(out.error).toBeUndefined();
    const result = out.result as LinkedAccountResult;
    expect(result).toMatchObject({
      found: true,
      discordId: SAMPLE_DISCORD_ID,
      minecraftUuid: SAMPLE_UUID,
      minecraftUsername: 'TestPlayer',
    });
  });

  it('returns found:false when no link exists', async () => {
    const { toolset } = makeHarness({ linkedAccount: { rows: [] } });
    const out = await toolset
      .get('db.resolve_linked_account')!
      .execute({ discordId: '111111111111111111' }, staffContext());
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({ found: false });
  });

  it('rejects duplicate account-link rows instead of silently choosing one', async () => {
    const row = {
      minecraft_uuid: SAMPLE_UUID,
      minecraft_username: 'TestPlayer',
      linked_at: '2026-01-02T03:04:05.000Z',
      link_source: 'discord-command',
    };
    const { toolset } = makeHarness({ linkedAccount: { rows: [row, { ...row }] } });
    const out = await toolset
      .get('db.resolve_linked_account')!
      .execute({ discordId: SAMPLE_DISCORD_ID }, staffContext());
    expect(out.error?.code).toBe('AMBIGUOUS_DB_RESULT');
    expect(out.result).toBeUndefined();
  });

  it('rejects a malformed discord id', async () => {
    const { toolset, mock } = makeHarness();
    const out = await toolset
      .get('db.resolve_linked_account')!
      .execute({ discordId: 'not-a-snowflake' }, staffContext());
    expect(out.error?.code).toBe('INVALID_TOOL_PARAMS');
    expect(out.result).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
  });
});

describe('db.get_player_rank', () => {
  it('returns the current rank', async () => {
    const { toolset } = makeHarness();
    const out = await toolset
      .get('db.get_player_rank')!
      .execute({ playerUuid: SAMPLE_UUID }, selfContext());
    expect(out.error).toBeUndefined();
    expect(out.result as PlayerRankResult).toMatchObject({
      found: true,
      playerUuid: SAMPLE_UUID,
      rankId: 'vip',
      rankName: 'VIP',
      expiresAt: null,
    });
  });

  it('returns found:false when the player has no current rank', async () => {
    const { toolset } = makeHarness({ playerRank: { rows: [] } });
    const out = await toolset
      .get('db.get_player_rank')!
      .execute({ playerUuid: OTHER_UUID }, staffContext());
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({ found: false, playerUuid: OTHER_UUID });
  });

  it('rejects a malformed UUID without touching the database', async () => {
    const { toolset, mock } = makeHarness();
    const out = await toolset
      .get('db.get_player_rank')!
      .execute({ playerUuid: 'not-a-uuid' }, staffContext());
    expect(out.error?.code).toBe('INVALID_TOOL_PARAMS');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('db.get_permission_state', () => {
  it('returns the effective granted state', async () => {
    const { toolset } = makeHarness();
    const out = await toolset
      .get('db.get_permission_state')!
      .execute(
        { playerUuid: SAMPLE_UUID, permissionNode: 'enthusia.trade' },
        selfContext(),
      );
    expect(out.error).toBeUndefined();
    expect(out.result as PermissionStateResult).toMatchObject({
      playerUuid: SAMPLE_UUID,
      permissionNode: 'enthusia.trade',
      granted: true,
      source: 'rank:vip',
    });
  });

  it('returns found:false when no permission record exists', async () => {
    const { toolset } = makeHarness({ permissionState: { rows: [] } });
    const out = await toolset
      .get('db.get_permission_state')!
      .execute(
        { playerUuid: SAMPLE_UUID, permissionNode: 'enthusia.fly' },
        selfContext(),
      );
    expect(out.error).toBeUndefined();
    expect(out.result as PermissionStateResult).toMatchObject({
      found: false,
      playerUuid: SAMPLE_UUID,
      permissionNode: 'enthusia.fly',
    });
  });

  it('rejects permission nodes outside the allowed charset', async () => {
    const { toolset, mock } = makeHarness();
    const out = await toolset
      .get('db.get_permission_state')!
      .execute(
        { playerUuid: SAMPLE_UUID, permissionNode: 'enthusia.trade; DROP' },
        staffContext(),
      );
    expect(out.error?.code).toBe('INVALID_TOOL_PARAMS');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('db.get_ticket_metadata', () => {
  it('returns status and subject for the requester', async () => {
    const { toolset } = makeHarness();
    const out = await toolset
      .get('db.get_ticket_metadata')!
      .execute({ ticketId: 'T-1001' }, selfContext());
    expect(out.error).toBeUndefined();
    expect(out.result as TicketMetadataResult).toMatchObject({
      ticketId: 'T-1001',
      status: 'open',
      subject: 'Help with my claim',
      subjectRedacted: false,
    });
  });

  it('returns NOT_FOUND for an unknown ticket', async () => {
    const { toolset } = makeHarness({ ticketMetadata: { rows: [] } });
    const out = await toolset
      .get('db.get_ticket_metadata')!
      .execute({ ticketId: 'T-9999' }, staffContext());
    expect(out.error?.code).toBe('NOT_FOUND');
    expect(out.result).toBeUndefined();
  });
});

describe('db.get_economy_fact', () => {
  it('returns an approved economy fact', async () => {
    const { toolset } = makeHarness();
    const out = await toolset
      .get('db.get_economy_fact')!
      .execute({ playerUuid: SAMPLE_UUID, factType: 'balance' }, selfContext());
    expect(out.error).toBeUndefined();
    expect(out.result as EconomyFactResult).toMatchObject({
      found: true,
      playerUuid: SAMPLE_UUID,
      factType: 'balance',
      value: '1500',
    });
  });

  it('rejects fact types outside the allowlist', async () => {
    const { toolset, mock } = makeHarness();
    const out = await toolset
      .get('db.get_economy_fact')!
      .execute(
        { playerUuid: SAMPLE_UUID, factType: 'password_hash' },
        staffContext(),
      );
    expect(out.error?.code).toBe('INVALID_TOOL_PARAMS');
    expect(mock.calls).toHaveLength(0);
  });

  it('returns found:false when the fact is absent', async () => {
    const { toolset } = makeHarness({ economyFact: { rows: [] } });
    const out = await toolset
      .get('db.get_economy_fact')!
      .execute(
        { playerUuid: SAMPLE_UUID, factType: 'lifetime_earned' },
        selfContext(),
      );
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({ found: false });
  });
});
