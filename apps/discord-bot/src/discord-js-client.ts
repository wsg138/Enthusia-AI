/**
 * @enthusia/discord-bot — discord.js client adapter (W06).
 *
 * Adapts a real discord.js `Client` into the `DiscordClientPort` the bot
 * core drives. This is the only module that touches discord.js; everything
 * else runs against the port and is tested with mocks — no live Discord
 * connection is ever needed for tests.
 *
 * Notes:
 * - Requires the `MessageContent` privileged intent to read message text;
 *   enable it in the Discord developer portal for the application.
 * - discord.js's REST layer already honors Discord 429s (retry-after) for
 *   sends and command registration; the bot's own per-user/global budgets
 *   (rate-limit.ts) sit on top of that per Master Specification §18.4.
 * - The bot NEVER connects in tests. `login()` is only called from the
 *   deployment entrypoint (startup.ts).
 */
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js';
import type { EnthusiaLogger } from '@enthusia/logging';

import type {
  DiscordChannelInfo,
  DiscordChannelKind,
  DiscordClientPort,
  DiscordMemberInfo,
  DiscordMessageRef,
  DiscordRoleInfo,
  DiscordSlashAskRef,
  OutgoingDiscordMessage,
  Snowflake,
} from './types.js';

export interface DiscordJsClientOptions {
  /** Bot token (secret — passed explicitly, never logged). */
  token: string;
  /** Register `/ai` for one guild (fast) instead of globally (slow). */
  slashCommandGuildId?: string;
  /** Test-only slash command mode requiring no privileged gateway intents. */
  slashOnly?: boolean;
}

export const AI_COMMAND_NAME = 'ai';
export const AI_ASK_SUBCOMMAND = 'ask';
export const AI_ASK_QUESTION_OPTION = 'question';

/** Build the `/ai ask <question>` command definition. */
export function buildAiSlashCommand(): { name: string; definition: unknown } {
  const definition = new SlashCommandBuilder()
    .setName(AI_COMMAND_NAME)
    .setDescription('Ask Enthusia AI')
    .addSubcommand((subcommand) =>
      subcommand
        .setName(AI_ASK_SUBCOMMAND)
        .setDescription('Ask Enthusia AI a question')
        .addStringOption((option) =>
          option
            .setName(AI_ASK_QUESTION_OPTION)
            .setDescription('Your question for Enthusia AI')
            .setRequired(true)
            .setMaxLength(1500),
        ),
    );
  return { name: AI_COMMAND_NAME, definition: definition.toJSON() };
}

/**
 * Upsert just the /ai command. A bulk PUT with [definition] would delete
 * unrelated commands registered by another component of the same app.
 * This never removes existing Ticket Bot or other application commands.
 */
export async function upsertAiSlashCommand(
  rest: Pick<REST, 'post'>,
  applicationId: string,
  guildId?: string,
): Promise<void> {
  const { definition } = buildAiSlashCommand();
  const route = guildId !== undefined
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId);
  await rest.post(route, { body: definition });
}

function channelKindOf(channel: Message['channel']): DiscordChannelKind {
  if (channel.isDMBased()) {
    return 'dm';
  }
  if (channel.isThread()) {
    return 'thread';
  }
  if (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement
  ) {
    return 'guild-text';
  }
  return 'other';
}

function channelInfoOf(channel: Message['channel']): DiscordChannelInfo {
  const info: DiscordChannelInfo = {
    id: channel.id,
    kind: channelKindOf(channel),
  };
  if ('name' in channel && typeof channel.name === 'string') {
    info.name = channel.name;
  }
  if ('guild' in channel && channel.guild) {
    info.guild = { id: channel.guild.id, name: channel.guild.name };
  }
  if (channel.isThread() && channel.parentId) {
    info.parentId = channel.parentId;
  }
  return info;
}

function memberInfoOf(message: Message): DiscordMemberInfo | undefined {
  const member = message.member;
  if (!member) {
    return undefined;
  }
  return {
    user: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName ?? undefined,
      isBot: message.author.bot,
    },
    roles: [...member.roles.cache.values()].map((role) => ({ id: role.id, name: role.name })),
    joinedAt: member.joinedAt?.toISOString(),
    nickname: member.nickname ?? undefined,
  };
}

/**
 * Normalize a discord.js Message into the port shape.
 * Exported for unit tests (pure function, no client needed).
 */
export function normalizeMessage(message: Message): DiscordMessageRef {
  return {
    id: message.id,
    channel: channelInfoOf(message.channel),
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName ?? undefined,
      isBot: message.author.bot,
    },
    member: memberInfoOf(message),
    content: message.content,
    mentionedUserIds: [...message.mentions.users.keys()],
    mentionsEveryone: message.mentions.everyone,
    createdAt: message.createdAt.toISOString(),
    ...(message.reference?.messageId ? { replyToMessageId: message.reference.messageId } : {}),
  };
}

/** Extract roles from either a cached GuildMember or a raw API member. */
function rolesOf(member: NonNullable<ChatInputCommandInteraction['member']>): DiscordRoleInfo[] {
  if (!('roles' in member)) {
    return [];
  }
  const roles = (member as { roles: unknown }).roles;
  if (roles !== null && typeof roles === 'object' && 'cache' in roles) {
    // discord.js GuildMemberRoleManager.
    const cache = (roles as { cache: Map<string, { id: string; name: string }> }).cache;
    return [...cache.values()].map((role) => ({ id: role.id, name: role.name }));
  }
  if (Array.isArray(roles)) {
    // Raw API member: role IDs only.
    return (roles as string[]).map((id) => ({ id, name: id }));
  }
  return [];
}

function memberInfoOfInteraction(
  interaction: ChatInputCommandInteraction,
): DiscordMemberInfo | undefined {
  const member = interaction.member;
  if (!member) {
    return undefined;
  }
  const joinedAt =
    'joinedAt' in member && member.joinedAt instanceof Date
      ? member.joinedAt.toISOString()
      : undefined;
  const nickname =
    'nickname' in member && typeof member.nickname === 'string' ? member.nickname : undefined;
  return {
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName ?? undefined,
      isBot: interaction.user.bot,
    },
    roles: rolesOf(member),
    ...(joinedAt !== undefined ? { joinedAt } : {}),
    ...(nickname !== undefined ? { nickname } : {}),
  };
}
/**
 * Normalize a `/ai ask` interaction into the port shape.
 * Returns null when the interaction is not an `/ai ask` invocation.
 * Exported for unit tests (pure function, no client needed).
 */
export function normalizeSlashAsk(
  interaction: ChatInputCommandInteraction,
): DiscordSlashAskRef | null {
  if (interaction.commandName !== AI_COMMAND_NAME) {
    return null;
  }
  let subcommand: string | null = null;
  try {
    subcommand = interaction.options.getSubcommand();
  } catch {
    return null;
  }
  if (subcommand !== AI_ASK_SUBCOMMAND) {
    return null;
  }
  const question = interaction.options.getString(AI_ASK_QUESTION_OPTION, true);
  return {
    id: interaction.id,
    channel: {
      id: interaction.channelId,
      kind: interaction.guildId ? 'guild-text' : 'other',
      ...(interaction.guildId ? { guild: { id: interaction.guildId, name: '' } } : {}),
    },
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName ?? undefined,
      isBot: interaction.user.bot,
    },
    member: memberInfoOfInteraction(interaction),
    question,
    createdAt: interaction.createdAt.toISOString(),
  };
}

export class DiscordJsClientAdapter implements DiscordClientPort {
  private readonly client: Client;
  private readonly rest: REST;
  private messageHandler: ((message: DiscordMessageRef) => void | Promise<void>) | null = null;
  private slashHandler: ((interaction: DiscordSlashAskRef) => void | Promise<void>) | null = null;
  private readyUserId: Snowflake | null = null;
  /**
   * Normalized interaction → raw discord.js interaction, so `respondToSlashAsk`
   * can defer/edit/follow-up. WeakMap: no lifetime beyond the interaction.
   */
  private readonly rawInteractions = new WeakMap<DiscordSlashAskRef, ChatInputCommandInteraction>();

  constructor(
    private readonly options: DiscordJsClientOptions,
    private readonly logger: EnthusiaLogger,
  ) {
    this.client = new Client({
      intents: options.slashOnly
        ? [GatewayIntentBits.Guilds]
        : [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          // Privileged intents used only by full message/role context mode.
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMembers,
        ],
    });
    this.rest = new REST({ version: '10' }).setToken(options.token);

    this.client.once(Events.ClientReady, (readyClient) => {
      this.readyUserId = readyClient.user.id;
      this.logger.info({ botUserId: this.readyUserId }, 'Discord client ready');
    });
    this.client.on(Events.MessageCreate, (message) => {
      if (this.options.slashOnly || this.messageHandler === null) {
        return;
      }
      try {
        const normalized = normalizeMessage(message);
        void Promise.resolve(this.messageHandler(normalized)).catch((error: unknown) => {
          this.logger.error({ error: String(error) }, 'message handler failed');
        });
      } catch (error) {
        this.logger.error({ error: String(error) }, 'failed to normalize incoming message');
      }
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (this.slashHandler === null || !interaction.isChatInputCommand()) {
        return;
      }
      const normalized = normalizeSlashAsk(interaction);
      if (normalized === null) {
        return;
      }
      // The raw interaction is needed to reply; keep it for the responder.
      this.rawInteractions.set(normalized, interaction);
      void Promise.resolve(this.slashHandler(normalized)).catch((error: unknown) => {
        this.logger.error({ error: String(error) }, 'slash handler failed');
      });
    });
    this.client.on(Events.Error, (error) => {
      this.logger.error({ error: String(error) }, 'Discord client error');
    });
  }

  get botUserId(): Snowflake | null {
    return this.readyUserId;
  }

  async login(): Promise<void> {
    await this.client.login(this.options.token);
  }

  onMessage(handler: (message: DiscordMessageRef) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onSlashAsk(handler: (interaction: DiscordSlashAskRef) => void | Promise<void>): void {
    this.slashHandler = handler;
  }

  async sendMessage(channelId: Snowflake, message: OutgoingDiscordMessage): Promise<Snowflake> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isSendable()) {
      throw new Error(`channel ${channelId} is not sendable`);
    }
    const sent = await channel.send({
      content: message.content,
      ...(message.replyToMessageId !== undefined
        ? { reply: { messageReference: message.replyToMessageId } }
        : {}),
    });
    return sent.id;
  }

  async respondToSlashAsk(interaction: DiscordSlashAskRef, chunks: string[]): Promise<void> {
    const raw = this.rawInteractions.get(interaction);
    if (!raw) {
      throw new Error('slash interaction is missing its raw Discord interaction');
    }
    const toSend = chunks.length === 0 ? ['_I received an empty response from the AI. Please try again._'] : chunks;
    await raw.deferReply();
    const [first, ...rest] = toSend as [string, ...string[]];
    await raw.editReply(first);
    for (const chunk of rest) {
      await raw.followUp(chunk);
    }
  }

  async registerSlashCommands(): Promise<void> {
    if (this.readyUserId === null) {
      throw new Error('cannot register slash commands before the client is ready');
    }
    await upsertAiSlashCommand(
      this.rest, this.readyUserId, this.options.slashCommandGuildId,
    );
    this.logger.info(
      { guildScoped: this.options.slashCommandGuildId !== undefined },
      'registered /ai slash command',
    );
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }
}
