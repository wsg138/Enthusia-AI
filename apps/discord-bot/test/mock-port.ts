/**
 * Mock Discord client port for tests. Records everything the bot core sends
 * so tests can assert the full Discord → gateway → Discord path without any
 * network or real Discord connection.
 */
import type {
  DiscordClientPort,
  DiscordMessageRef,
  DiscordSlashAskRef,
  OutgoingDiscordMessage,
  Snowflake,
} from '../src/types.js';

export interface SentMessage {
  channelId: Snowflake;
  message: OutgoingDiscordMessage;
}

export class MockDiscordClientPort implements DiscordClientPort {
  botUserId: Snowflake | null = 'bot-user-id';
  readonly sentMessages: SentMessage[] = [];
  readonly slashResponses: { interaction: DiscordSlashAskRef; chunks: string[] }[] = [];
  private messageHandler: ((message: DiscordMessageRef) => void | Promise<void>) | null = null;
  private slashHandler: ((interaction: DiscordSlashAskRef) => void | Promise<void>) | null = null;
  registerSlashCommandsCalled = false;
  destroyed = false;

  async login(): Promise<void> {
    // No-op: no real Discord connection in tests.
  }

  onMessage(handler: (message: DiscordMessageRef) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onSlashAsk(handler: (interaction: DiscordSlashAskRef) => void | Promise<void>): void {
    this.slashHandler = handler;
  }

  async sendMessage(channelId: Snowflake, message: OutgoingDiscordMessage): Promise<Snowflake> {
    this.sentMessages.push({ channelId, message });
    return `sent-${this.sentMessages.length}`;
  }

  async respondToSlashAsk(interaction: DiscordSlashAskRef, chunks: string[]): Promise<void> {
    this.slashResponses.push({ interaction, chunks });
  }

  async registerSlashCommands(): Promise<void> {
    this.registerSlashCommandsCalled = true;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  /** Drive an incoming message through the wired handler (like Discord would). */
  async emitMessage(message: DiscordMessageRef): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(message);
    }
  }

  /** Drive a `/ai ask` invocation through the wired handler. */
  async emitSlashAsk(interaction: DiscordSlashAskRef): Promise<void> {
    if (this.slashHandler) {
      await this.slashHandler(interaction);
    }
  }
}

import { Visibility } from '@enthusia/contracts';
import type { EnthusiaLogger } from '@enthusia/logging';

import type { DiscordBotOptions } from '../src/config.js';

/** Base options for tests: strict defaults, generous rate limits, mock gateway. */
export function testOptions(overrides: Partial<DiscordBotOptions> = {}): DiscordBotOptions {
  return {
    botName: 'Enthusia AI',
    gatewayBaseUrl: 'http://127.0.0.1:4100',
    useMockGateway: true,
    gatewayTimeoutMs: 1000,
    aiChannelIds: [],
    staffChannelIds: [],
    testChannelIds: [],
    staffRoleIds: [],
    defaultVisibilityCeiling: Visibility.PUBLIC,
    perUserRateLimit: { maxRequests: 1000, windowMs: 60_000 },
    globalRateLimit: { maxRequests: 10000, windowMs: 60_000 },
    maxMessageChars: 2000,
    maxChunksPerResponse: 10,
    ...overrides,
  };
}

let idCounter = 0;

/** Minimal guild message fixture. */
export function guildMessage(overrides: Partial<DiscordMessageRef> = {}): DiscordMessageRef {
  idCounter += 1;
  return {
    id: `msg-${idCounter}`,
    channel: {
      id: 'channel-1',
      name: 'general',
      kind: 'guild-text',
      guild: { id: 'guild-1', name: 'Enthusia' },
    },
    author: { id: 'user-1', username: 'player1', isBot: false },
    member: {
      user: { id: 'user-1', username: 'player1', isBot: false },
      roles: [],
    },
    content: 'hello',
    mentionedUserIds: [],
    mentionsEveryone: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Minimal `/ai ask` fixture. */
export function slashAsk(overrides: Partial<DiscordSlashAskRef> = {}): DiscordSlashAskRef {
  idCounter += 1;
  return {
    id: `interaction-${idCounter}`,
    channel: {
      id: 'channel-1',
      name: 'general',
      kind: 'guild-text',
      guild: { id: 'guild-1', name: 'Enthusia' },
    },
    user: { id: 'user-1', username: 'player1', isBot: false },
    question: 'what is the server ip?',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Null logger: discards everything (bot tests assert behavior, not logs). */
export function nullLogger(): EnthusiaLogger {
  const noop = (): void => {};
  const self = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    withTraceId: () => self,
    child: () => self,
  };
  return self as unknown as EnthusiaLogger;
}
