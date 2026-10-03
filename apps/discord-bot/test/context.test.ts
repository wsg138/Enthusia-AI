/**
 * Tests for actor context extraction: identity, role mapping, join-time
 * context, visibility ceilings, and conversation IDs.
 */
import { Visibility } from '@enthusia/contracts';
import { describe, expect, it } from 'vitest';

import {
  displayNameFor,
  extractMessageContext,
  extractSlashAskContext,
  mapRoles,
} from '../src/context.js';
import { guildMessage, slashAsk, testOptions } from './mock-port.js';

const STAFF_ROLE = 'role-staff';

function memberWithRoles(roles: { id: string; name: string }[], joinedAt = '2026-09-01T12:00:00.000Z') {
  return {
    user: { id: 'user-1', username: 'player1', isBot: false },
    roles,
    joinedAt,
    nickname: 'PlayerOne',
  };
}

describe('mapRoles', () => {
  it('marks staff when a staff role is present', () => {
    const mapped = mapRoles(
      [
        { id: 'role-member', name: 'Member' },
        { id: STAFF_ROLE, name: 'Staff' },
      ],
      [STAFF_ROLE],
    );
    expect(mapped.isStaff).toBe(true);
    expect(mapped.roleNames).toEqual(['Member', 'Staff']);
    expect(mapped.roleIds).toEqual(['role-member', STAFF_ROLE]);
  });

  it('marks non-staff otherwise', () => {
    const mapped = mapRoles([{ id: 'role-member', name: 'Member' }], [STAFF_ROLE]);
    expect(mapped.isStaff).toBe(false);
  });
});

describe('displayNameFor', () => {
  it('prefers nickname, then display name, then username', () => {
    const member = memberWithRoles([]);
    expect(displayNameFor(member, 'user-1', 'player1', 'Display')).toBe('PlayerOne');
    expect(displayNameFor({ ...member, nickname: undefined }, 'user-1', 'player1', 'Display')).toBe(
      'Display',
    );
    expect(
      displayNameFor({ ...member, nickname: undefined }, 'user-1', 'player1', undefined),
    ).toBe('player1');
  });
});

describe('extractMessageContext', () => {
  it('builds a player actor with channel context', () => {
    const ctx = extractMessageContext(
      guildMessage({ member: memberWithRoles([{ id: 'role-member', name: 'Member' }]) }),
      'mention',
      testOptions(),
    );
    expect(ctx.actor.id).toBe('user-1');
    expect(ctx.actor.type).toBe('player');
    expect(ctx.actor.displayName).toBe('PlayerOne');
    expect(ctx.visibilityCeiling).toBe(Visibility.PUBLIC);
    expect(ctx.conversationId).toBe('discord:guild-1:channel-1');
    expect(ctx.context['trigger']).toBe('mention');
    expect(ctx.context['memberJoinedAt']).toBe('2026-09-01T12:00:00.000Z');
    expect(ctx.context['roleNames']).toEqual(['Member']);
    expect(ctx.context['guildId']).toBe('guild-1');
    expect(ctx.isStaff).toBe(false);
  });

  it('marks staff actors when a staff role is present', () => {
    const ctx = extractMessageContext(
      guildMessage({ member: memberWithRoles([{ id: STAFF_ROLE, name: 'Staff' }]) }),
      'mention',
      testOptions({ staffRoleIds: [STAFF_ROLE] }),
    );
    expect(ctx.actor.type).toBe('staff');
    expect(ctx.isStaff).toBe(true);
    // Still PUBLIC outside a staff channel (conservative initial policy).
    expect(ctx.visibilityCeiling).toBe(Visibility.PUBLIC);
  });

  it('raises the ceiling to STAFF for staff in a staff channel', () => {
    const ctx = extractMessageContext(
      guildMessage({
        member: memberWithRoles([{ id: STAFF_ROLE, name: 'Staff' }]),
        channel: { id: 'staff-chan', kind: 'guild-text', guild: { id: 'guild-1', name: 'Enthusia' } },
      }),
      'mention',
      testOptions({ staffRoleIds: [STAFF_ROLE], staffChannelIds: ['staff-chan'] }),
    );
    expect(ctx.visibilityCeiling).toBe(Visibility.STAFF);
  });

  it('uses unknown actor type without guild member info (e.g. DMs)', () => {
    const msg = guildMessage({
      member: undefined,
      channel: { id: 'dm-chan', kind: 'dm' },
    });
    const ctx = extractMessageContext(msg, 'mention', testOptions());
    expect(ctx.actor.type).toBe('unknown');
    expect(ctx.conversationId).toBe('discord:dm:dm-chan');
    expect(ctx.context['memberJoinedAt']).toBeUndefined();
  });

  it('never puts secrets in the context object', () => {
    const ctx = extractMessageContext(guildMessage(), 'mention', testOptions());
    const serialized = JSON.stringify(ctx.context);
    expect(serialized).not.toMatch(/token|secret|password|key/i);
  });
});

describe('extractSlashAskContext', () => {
  it('extracts context from a slash interaction', () => {
    const ctx = extractSlashAskContext(
      slashAsk({ member: memberWithRoles([{ id: 'role-member', name: 'Member' }]) }),
      testOptions(),
    );
    expect(ctx.actor.id).toBe('user-1');
    expect(ctx.actor.type).toBe('player');
    expect(ctx.context['trigger']).toBe('slash');
    expect(ctx.conversationId).toBe('discord:guild-1:channel-1');
  });
});
