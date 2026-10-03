/**
 * @enthusia/discord-bot — actor context extraction (W06).
 *
 * Owns:
 * - actor identity (Discord user ID, display name, staff/player/unknown type);
 * - role context mapping (Discord roles → staff marker + role names);
 * - join-time context (member.joinedAt);
 * - the visibility ceiling for the request (conservative initial policy);
 * - the surface context object attached to the ChatRequest.
 *
 * Does NOT own: linking Discord users to Minecraft accounts (W11), ticket
 * state (W14), or memory (W05). `linkedUuid` is left unset until W11 lands.
 *
 * Spec: MASTER-SPECIFICATION.md §6.1, §17 (visibility), §48.1 (chat request).
 */
import { Visibility, type Actor, type ActorType } from '@enthusia/contracts';

import type { DiscordBotOptions } from './config.js';
import type {
  DiscordMemberInfo,
  DiscordMessageRef,
  DiscordRoleInfo,
  DiscordSlashAskRef,
} from './types.js';
import type { TriggerKind } from './policy.js';

/** Result of extracting context from one Discord interaction. */
export interface ExtractedActorContext {
  /** The contracts `Actor` for the ChatRequest. */
  actor: Actor;
  /** Visibility ceiling for the response (§17). */
  visibilityCeiling: Visibility;
  /** Surface context for the ChatRequest. No secrets, ever. */
  context: Record<string, unknown>;
  /** Channel-scoped conversation ID for continuity. */
  conversationId: string;
  /** True when the actor holds a configured staff role. */
  isStaff: boolean;
}

/** Map Discord roles to staff membership + names (role context mapping). */
export function mapRoles(
  roles: DiscordRoleInfo[],
  staffRoleIds: readonly string[],
): { roleIds: string[]; roleNames: string[]; isStaff: boolean } {
  const roleIds = roles.map((role) => role.id);
  return {
    roleIds,
    roleNames: roles.map((role) => role.name),
    isStaff: roleIds.some((id) => staffRoleIds.includes(id)),
  };
}

/** Prefer guild nickname, then display name, then username. */
export function displayNameFor(
  member: DiscordMemberInfo | undefined,
  userId: string,
  username: string,
  displayName: string | undefined,
): string {
  if (member?.nickname) {
    return member.nickname;
  }
  if (displayName) {
    return displayName;
  }
  return username || userId;
}

function conversationIdFor(channel: DiscordMessageRef['channel']): string {
  const scope = channel.guild ? channel.guild.id : 'dm';
  return `discord:${scope}:${channel.id}`;
}

interface RawActorInput {
  userId: string;
  username: string;
  displayName?: string | undefined;
  member?: DiscordMemberInfo | undefined;
  channel: DiscordMessageRef['channel'];
  messageId?: string;
  trigger: TriggerKind;
}

function extractFromRaw(input: RawActorInput, options: DiscordBotOptions): ExtractedActorContext {
  const { roleIds, roleNames, isStaff } = mapRoles(
    input.member?.roles ?? [],
    options.staffRoleIds,
  );

  // Actor type: staff when a configured staff role is present. Without guild
  // member info (e.g. DMs) we cannot tell — use 'unknown', never guess.
  const actorType: ActorType = input.member === undefined ? 'unknown' : isStaff ? 'staff' : 'player';

  const actor: Actor = {
    id: input.userId,
    type: actorType,
    displayName: displayNameFor(input.member, input.userId, input.username, input.displayName),
    // TODO(W11): fill linkedUuid from the player-identity service once it exists.
  };

  // Conservative initial ceiling: STAFF only for staff actors inside a
  // configured staff-only channel; everything else stays at the default
  // (PUBLIC). The agent (W12) owns finer authorization later.
  const visibilityCeiling =
    isStaff && options.staffChannelIds.includes(input.channel.id)
      ? Visibility.STAFF
      : options.defaultVisibilityCeiling;

  const context: Record<string, unknown> = {
    discordUserId: input.userId,
    discordUsername: input.username,
    channelId: input.channel.id,
    channelKind: input.channel.kind,
    trigger: input.trigger,
    isStaff,
    roleIds,
    roleNames,
    ...(input.channel.name !== undefined ? { channelName: input.channel.name } : {}),
    ...(input.channel.guild !== undefined
      ? { guildId: input.channel.guild.id, guildName: input.channel.guild.name }
      : {}),
    ...(input.channel.parentId !== undefined ? { parentChannelId: input.channel.parentId } : {}),
    ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
    // Join-time context: ISO timestamp when the member object carries it.
    ...(input.member?.joinedAt !== undefined ? { memberJoinedAt: input.member.joinedAt } : {}),
  };

  return {
    actor,
    visibilityCeiling,
    context,
    conversationId: conversationIdFor(input.channel),
    isStaff,
  };
}

/** Extract actor context from an incoming message. */
export function extractMessageContext(
  message: DiscordMessageRef,
  trigger: TriggerKind,
  options: DiscordBotOptions,
): ExtractedActorContext {
  return extractFromRaw(
    {
      userId: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName,
      member: message.member,
      channel: message.channel,
      messageId: message.id,
      trigger,
    },
    options,
  );
}

/** Extract actor context from a `/ai ask` interaction. */
export function extractSlashAskContext(
  interaction: DiscordSlashAskRef,
  options: DiscordBotOptions,
): ExtractedActorContext {
  return extractFromRaw(
    {
      userId: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName,
      member: interaction.member,
      channel: interaction.channel,
      messageId: interaction.id,
      trigger: 'slash',
    },
    options,
  );
}
