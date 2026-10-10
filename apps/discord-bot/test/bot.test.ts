/**
 * Integration tests for the bot core: a Discord message (via the mock
 * client port) reaches the AI Gateway and the returned response is
 * formatted and sent. No real Discord connection, no real gateway.
 */
import { isValidTraceId, Visibility, type AgentResponse, type ChatRequest } from '@enthusia/contracts';
import { ExternalServiceError } from '@enthusia/contracts';
import { describe, expect, it } from 'vitest';

import { EnthusiaAiDiscordBot } from '../src/bot.js';
import { MockAiGatewayClient, type AiGatewayClient } from '../src/gateway-client.js';
import { MockDiscordClientPort, guildMessage, nullLogger, slashAsk, testOptions } from './mock-port.js';

const BOT_ID = 'bot-user-id';

/** Gateway double that records requests and replays a scripted response. */
class RecordingGateway implements AiGatewayClient {
  readonly requests: ChatRequest[] = [];
  constructor(
    private readonly respond: (request: ChatRequest) => AgentResponse | Promise<AgentResponse> = (request) => ({
      text: `echo: ${request.message}`,
      actions: [],
      sources: [],
      memoryUpdates: [],
      escalation: null,
      traceId: request.traceId ?? 'no-trace',
    }),
  ) {}

  async sendChat(request: ChatRequest): Promise<AgentResponse> {
    this.requests.push(request);
    return this.respond(request);
  }
}

function setup(gateway: AiGatewayClient = new RecordingGateway(), options = testOptions()) {
  const port = new MockDiscordClientPort();
  const bot = new EnthusiaAiDiscordBot(port, gateway, options, nullLogger());
  return { port, bot };
}

describe('EnthusiaAiDiscordBot message flow', () => {
  it('routes a mention to the gateway and sends the formatted reply', async () => {
    const gateway = new RecordingGateway();
    const { port, bot } = setup(gateway);
    const incoming = guildMessage({ content: `<@${BOT_ID}> what is the ip?`, mentionedUserIds: [BOT_ID] });

    const result = await bot.handleMessage(incoming);

    expect(result.outcome).toBe('responded');
    expect(result.traceId).toBeDefined();
    expect(isValidTraceId(result.traceId!)).toBe(true);

    // The ChatRequest handed to the gateway…
    expect(gateway.requests).toHaveLength(1);
    const request = gateway.requests[0]!;
    expect(request.surface).toBe('discord');
    expect(request.message).toBe('what is the ip?');
    expect(request.actor.id).toBe('user-1');
    expect(request.actor.type).toBe('player');
    expect(request.visibilityCeiling).toBe(Visibility.PUBLIC);
    expect(request.traceId).toBe(result.traceId);
    expect(request.context!['trigger']).toBe('mention');

    // …and the formatted response sent back as a reply.
    expect(port.sentMessages).toHaveLength(1);
    expect(port.sentMessages[0]!.channelId).toBe('channel-1');
    expect(port.sentMessages[0]!.message.replyToMessageId).toBe(incoming.id);
    expect(port.sentMessages[0]!.message.content).toBe('echo: what is the ip?');
  });

  it('refuses even a direct mention outside the configured test guild or channel', async () => {
    const gateway = new RecordingGateway();
    const options = testOptions({
      allowedGuildIds: ['guild-1'],
      allowedChannelIds: ['channel-1'],
    });
    const { port, bot } = setup(gateway, options);
    const mention = `<@${BOT_ID}> can you help?`;
    const wrongGuild = guildMessage({
      content: mention,
      mentionedUserIds: [BOT_ID],
      channel: { id: 'channel-1', kind: 'guild-text', guild: { id: 'guild-2', name: 'Other' } },
    });
    const wrongChannel = guildMessage({
      content: mention,
      mentionedUserIds: [BOT_ID],
      channel: { id: 'ticket-logs', kind: 'guild-text', guild: { id: 'guild-1', name: 'Test' } },
    });
    const dm = guildMessage({
      content: mention,
      mentionedUserIds: [BOT_ID],
      channel: { id: 'dm-1', kind: 'dm' },
    });
    for (const message of [wrongGuild, wrongChannel, dm]) {
      expect((await bot.handleMessage(message)).outcome).toBe('ignored');
    }
    expect(gateway.requests).toHaveLength(0);
    expect(port.sentMessages).toHaveLength(0);
  });

  it('ignores messages with no trigger: no gateway call, nothing sent', async () => {
    const gateway = new RecordingGateway();
    const { port, bot } = setup(gateway);

    const result = await bot.handleMessage(guildMessage({ content: 'just chatting' }));

    expect(result.outcome).toBe('ignored');
    expect(gateway.requests).toHaveLength(0);
    expect(port.sentMessages).toHaveLength(0);
  });

  it('ignores messages from other bots', async () => {
    const gateway = new RecordingGateway();
    const { bot } = setup(gateway);
    const result = await bot.handleMessage(
      guildMessage({
        content: `<@${BOT_ID}> hi`,
        mentionedUserIds: [BOT_ID],
        author: { id: 'bot-2', username: 'other', isBot: true },
      }),
    );
    expect(result.outcome).toBe('ignored');
    expect(gateway.requests).toHaveLength(0);
  });

  it('answers a bare mention with a greeting and no gateway call', async () => {
    const gateway = new RecordingGateway();
    const { port, bot } = setup(gateway);

    const result = await bot.handleMessage(
      guildMessage({ content: `<@${BOT_ID}>`, mentionedUserIds: [BOT_ID] }),
    );

    expect(result.outcome).toBe('greeted');
    expect(gateway.requests).toHaveLength(0);
    expect(port.sentMessages).toHaveLength(1);
    expect(port.sentMessages[0]!.message.content).toContain('Enthusia AI');
  });

  it('answers test-channel messages without a mention', async () => {
    const gateway = new RecordingGateway();
    const options = testOptions({ testChannelIds: ['test-chan'] });
    const { port, bot } = setup(gateway, options);

    const result = await bot.handleMessage(
      guildMessage({ content: 'channel question', channel: { id: 'test-chan', kind: 'guild-text' } }),
    );

    expect(result.outcome).toBe('responded');
    expect(gateway.requests[0]!.context!['trigger']).toBe('test-channel');
    expect(port.sentMessages).toHaveLength(1);
  });

  it('rate-limits a spamming user with a polite notice and no gateway call', async () => {
    const gateway = new RecordingGateway();
    const options = testOptions({ perUserRateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const { port, bot } = setup(gateway, options);
    const mention = guildMessage({ content: `<@${BOT_ID}> q`, mentionedUserIds: [BOT_ID] });

    expect((await bot.handleMessage(mention)).outcome).toBe('responded');
    const limited = await bot.handleMessage(mention);
    expect(limited.outcome).toBe('rate-limited');
    expect(gateway.requests).toHaveLength(1);
    expect(port.sentMessages).toHaveLength(2);
    expect(port.sentMessages[1]!.message.content).toContain('too fast');
  });

  it('sends a generic fallback when the gateway fails, leaking no internals', async () => {
    const gateway = new RecordingGateway(() => {
      throw new ExternalServiceError('ai-gateway', 'connection refused to 10.0.0.99:4100', {
        detail: { host: '10.0.0.99' },
      });
    });
    const { port, bot } = setup(gateway);

    const result = await bot.handleMessage(
      guildMessage({ content: `<@${BOT_ID}> hi`, mentionedUserIds: [BOT_ID] }),
    );

    expect(result.outcome).toBe('gateway-error');
    expect(port.sentMessages).toHaveLength(1);
    const sent = port.sentMessages[0]!.message.content;
    expect(sent).not.toContain('10.0.0.99');
    expect(sent).not.toContain('connection refused');
    expect(sent).toContain('could not reach the AI');
  });

  it('uses understandable, distinct fallback messages for timeouts and rate limits', async () => {
    const { ToolTimeoutError, RateLimitError } = await import('@enthusia/contracts');
    for (const [error, fragment] of [
      [new ToolTimeoutError('ai-gateway', 130000), 'longer than expected'],
      [new RateLimitError('rate limited'), 'handling too many requests'],
    ] as const) {
      const { port, bot } = setup(new RecordingGateway(() => { throw error; }));
      const result = await bot.handleMessage(guildMessage({
        content: `<@${BOT_ID}> Can you explain Warzones?`,
        mentionedUserIds: [BOT_ID],
      }));
      expect(result.outcome).toBe('gateway-error');
      expect(port.sentMessages[0]?.message.content).toContain(fragment);
      expect(port.sentMessages[0]?.message.content).not.toContain('could not reach the AI');
    }
  });

  it('splits long responses into ordered reply chunks', async () => {
    const longText = 'paragraph one.\n\n' + 'x'.repeat(5000);
    const gateway = new RecordingGateway((request) => ({
      text: longText,
      actions: [],
      sources: [],
      memoryUpdates: [],
      escalation: null,
      traceId: request.traceId ?? 'no-trace',
    }));
    const { port, bot } = setup(gateway);

    await bot.handleMessage(guildMessage({ content: `<@${BOT_ID}> long`, mentionedUserIds: [BOT_ID] }));

    expect(port.sentMessages.length).toBeGreaterThan(1);
    for (const sent of port.sentMessages) {
      expect(sent.message.content.length).toBeLessThanOrEqual(2000);
    }
    // First chunk is the reply; the rest follow in order.
    expect(port.sentMessages[0]!.message.replyToMessageId).toBeDefined();
    expect(port.sentMessages.slice(1).every((s) => s.message.replyToMessageId === undefined)).toBe(true);
    expect(port.sentMessages.map((s) => s.message.content).join('')).toContain('paragraph one.');
  });

  it('start() wires handlers so port events flow through the pipeline', async () => {
    const gateway = new RecordingGateway();
    const port = new MockDiscordClientPort();
    const bot = new EnthusiaAiDiscordBot(port, gateway, testOptions(), nullLogger());
    await bot.start();

    expect(port.registerSlashCommandsCalled).toBe(true);
    await port.emitMessage(guildMessage({ content: `<@${BOT_ID}> hi`, mentionedUserIds: [BOT_ID] }));
    // The start() handler catches errors internally; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gateway.requests).toHaveLength(1);
    expect(port.sentMessages).toHaveLength(1);
    await bot.stop();
    expect(port.destroyed).toBe(true);
  });
});

describe('EnthusiaAiDiscordBot slash flow', () => {
  it('does not answer /ai ask outside the test channel or guild', async () => {
    const gateway = new RecordingGateway();
    const { port, bot } = setup(gateway, testOptions({
      allowedGuildIds: ['guild-1'],
      allowedChannelIds: ['channel-1'],
    }));
    for (const channel of [
      { id: 'ticket-logs', kind: 'guild-text' as const, guild: { id: 'guild-1', name: 'Test' } },
      { id: 'channel-1', kind: 'guild-text' as const, guild: { id: 'guild-2', name: 'Other' } },
      { id: 'dm', kind: 'dm' as const },
    ]) {
      const result = await bot.handleSlashAsk(slashAsk({ channel }));
      expect(result.outcome).toBe('ignored');
    }
    expect(gateway.requests).toHaveLength(0);
    expect(port.slashResponses).toHaveLength(0);
  });

  it('accepts scoped /ai ask in the designated test channel', async () => {
    const gateway = new RecordingGateway();
    const { port, bot } = setup(gateway, testOptions({
      allowedGuildIds: ['guild-1'],
      allowedChannelIds: ['channel-1'],
    }));
    expect((await bot.handleSlashAsk(slashAsk())).outcome).toBe('responded');
    expect(gateway.requests).toHaveLength(1);
    expect(port.slashResponses).toHaveLength(1);
  });

  it('routes /ai ask through respondToSlashAsk with formatted chunks', async () => {
    const gateway = new RecordingGateway();
    const { port, bot } = setup(gateway);
    const interaction = slashAsk({ question: 'how do I claim land?' });

    const result = await bot.handleSlashAsk(interaction);

    expect(result.outcome).toBe('responded');
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.message).toBe('how do I claim land?');
    expect(gateway.requests[0]!.context!['trigger']).toBe('slash');
    expect(port.slashResponses).toHaveLength(1);
    expect(port.slashResponses[0]!.interaction).toBe(interaction);
    expect(port.slashResponses[0]!.chunks).toEqual(['echo: how do I claim land?']);
  });

  it('defers the slash response before waiting for a slow gateway', async () => {
    const port = new MockDiscordClientPort();
    const gateway = new RecordingGateway(async (request) => {
      expect(port.deferredSlashes).toHaveLength(1);
      return {
        text: 'ready', actions: [], sources: [], memoryUpdates: [],
        escalation: null, traceId: request.traceId ?? 'no-trace',
      };
    });
    const bot = new EnthusiaAiDiscordBot(port, gateway, testOptions(), nullLogger());
    const interaction = slashAsk({ question: 'slow request' });
    expect((await bot.handleSlashAsk(interaction)).outcome).toBe('responded');
    expect(port.deferredSlashes).toEqual([interaction]);
    expect(port.slashResponses).toHaveLength(1);
  });

  it('rate-limits slash invocations too', async () => {
    const gateway = new RecordingGateway();
    const options = testOptions({ perUserRateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const { port, bot } = setup(gateway, options);

    expect((await bot.handleSlashAsk(slashAsk())).outcome).toBe('responded');
    const limited = await bot.handleSlashAsk(slashAsk());
    expect(limited.outcome).toBe('rate-limited');
    expect(gateway.requests).toHaveLength(1);
    expect(port.slashResponses[1]!.chunks[0]).toContain('too fast');
  });
});

describe('mock gateway end to end', () => {
  it('serves a mention through MockAiGatewayClient without HTTP', async () => {
    const { port, bot } = setup(new MockAiGatewayClient());
    const result = await bot.handleMessage(
      guildMessage({ content: `<@${BOT_ID}> hello`, mentionedUserIds: [BOT_ID] }),
    );
    expect(result.outcome).toBe('responded');
    expect(port.sentMessages).toHaveLength(1);
    expect(port.sentMessages[0]!.message.content).toContain('mock gateway');
  });
});
