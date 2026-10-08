/**
 * @enthusia/discord-bot — Discord port types (W06).
 *
 * These are the minimal structural types the bot core depends on. They are
 * intentionally NOT discord.js types: the core (policy, context, formatting,
 * rate limiting, orchestration) runs against these interfaces, and
 * `discord-js-client.ts` adapts a real discord.js Client into them.
 * Tests inject a mock implementation — the bot never needs a live Discord
 * connection to be exercised.
 *
 * Spec: MASTER-SPECIFICATION.md §6.1 (Discord bot), §18 (Discord behavior).
 */

/** Discord snowflake ID (users, guilds, channels, messages, roles). */
export type Snowflake = string;

/** A Discord user, as seen by the bot. */
export interface DiscordUserInfo {
  id: Snowflake;
  username: string;
  /** Server display name when available. */
  displayName?: string | undefined;
  /** True for bots and webhooks — the bot never answers these (§18.1). */
  isBot: boolean;
}

/** A Discord role on a guild member. */
export interface DiscordRoleInfo {
  id: Snowflake;
  name: string;
}

/** A guild member: user + roles + join time (join-time context, W06 owns). */
export interface DiscordMemberInfo {
  user: DiscordUserInfo;
  roles: DiscordRoleInfo[];
  /** ISO-8601 guild join time, when the member object carries it. */
  joinedAt?: string | undefined;
  /** Guild nickname, when set. */
  nickname?: string | undefined;
}

/** A Discord guild (server). */
export interface DiscordGuildInfo {
  id: Snowflake;
  name: string;
}

/** Channel kinds the adapter distinguishes. */
export type DiscordChannelKind = 'guild-text' | 'dm' | 'thread' | 'other';

/** A Discord channel, as seen by the bot. */
export interface DiscordChannelInfo {
  id: Snowflake;
  name?: string | undefined;
  kind: DiscordChannelKind;
  /** Present for guild channels/threads. */
  guild?: DiscordGuildInfo;
  /** Parent channel for threads. */
  parentId?: Snowflake | undefined;
}

/**
 * A Discord message, normalized by the client adapter.
 * The bot core only ever sees this shape.
 */
export interface DiscordMessageRef {
  id: Snowflake;
  channel: DiscordChannelInfo;
  author: DiscordUserInfo;
  /** Present for guild messages. */
  member?: DiscordMemberInfo | undefined;
  content: string;
  /** User IDs mentioned anywhere in the message. */
  mentionedUserIds: Snowflake[];
  /** True when the message used @everyone / @here. */
  mentionsEveryone: boolean;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** Set when the message is a reply to another message. */
  replyToMessageId?: Snowflake | undefined;
}

/**
 * A `/ai ask` slash-command invocation, normalized by the client adapter.
 */
export interface DiscordSlashAskRef {
  id: Snowflake;
  channel: DiscordChannelInfo;
  user: DiscordUserInfo;
  /** Present for guild invocations. */
  member?: DiscordMemberInfo | undefined;
  /** The resolved `question` option. */
  question: string;
  /** ISO-8601 creation time. */
  createdAt: string;
}

/** One outbound Discord message. */
export interface OutgoingDiscordMessage {
  content: string;
  /** When set, the message is sent as a reply to this message. */
  replyToMessageId?: Snowflake | undefined;
}

/**
 * Port the bot core drives. `discord-js-client.ts` implements this against a
 * real discord.js Client; tests implement it with an in-memory mock.
 */
export interface DiscordClientPort {
  /** The bot's own user ID once logged in / ready; null before. */
  readonly botUserId: Snowflake | null;

  /** Connect to Discord. The token is supplied by the deployment layer. */
  login(): Promise<void>;

  /** Register a handler for incoming guild/DM messages. */
  onMessage(handler: (message: DiscordMessageRef) => void | Promise<void>): void;

  /** Register a handler for `/ai ask` invocations. */
  onSlashAsk(handler: (interaction: DiscordSlashAskRef) => void | Promise<void>): void;

  /**
   * Send a message to a channel. The caller is responsible for chunking
   * (see formatting.ts); each call sends exactly one Discord message.
   * Resolves with the sent message ID.
   */
  sendMessage(channelId: Snowflake, message: OutgoingDiscordMessage): Promise<Snowflake>;

  /**
   * Slash-command flow: acknowledge the interaction, then deliver each chunk
   * in order (first chunk edits the deferred reply, the rest are follow-ups).
   */
  respondToSlashAsk(interaction: DiscordSlashAskRef, chunks: string[]): Promise<void>;

  /** Acknowledge an allowed slash command immediately; AI inference may take seconds. */
  deferSlashAsk?(interaction: DiscordSlashAskRef): Promise<void>;

  /** Register the `/ai` slash command (global or per-guild). */
  registerSlashCommands(): Promise<void>;

  /** Disconnect and release resources. */
  destroy(): Promise<void>;
}
