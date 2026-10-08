import { describe, it, expect } from 'vitest';
import { EnthusiaAiDiscordBot } from '../src/bot.js';
import { MockAiGatewayClient } from '../src/gateway-client.js';
import { MockDiscordClientPort, guildMessage, slashAsk, testOptions, nullLogger } from './mock-port.js';

describe('isolated Discord testing scope', () => {
  function setup() {
    const port = new MockDiscordClientPort();
    const bot = new EnthusiaAiDiscordBot(port, new MockAiGatewayClient(),
      testOptions({ allowedGuildIds: ['guild-test'], allowedChannelIds: ['ai-test'] }), nullLogger());
    return { port, bot };
  }
  it('ignores mentions from the real server despite a valid mention', async () => {
    const { bot, port } = setup();
    const result = await bot.handleMessage(guildMessage({
      content: '<@bot-user-id> help', mentionedUserIds: ['bot-user-id'],
      channel: { id: 'ai-test', kind: 'guild-text', guild: { id: 'guild-real', name: 'Production' } },
    }));
    expect(result.outcome).toBe('ignored');
    expect(port.sentMessages).toHaveLength(0);
  });
  it('ignores test-guild messages sent to ticket logs', async () => {
    const { bot, port } = setup();
    const result = await bot.handleMessage(guildMessage({
      content: '<@bot-user-id> help', mentionedUserIds: ['bot-user-id'],
      channel: { id: 'ticket-logs', kind: 'guild-text', guild: { id: 'guild-test', name: 'Test' } },
    }));
    expect(result.outcome).toBe('ignored');
    expect(port.sentMessages).toHaveLength(0);
  });
  it('ignores slash commands outside the exact test channel', async () => {
    const { bot, port } = setup();
    expect((await bot.handleSlashAsk(slashAsk({
      channel: { id: 'ticket-logs', kind: 'guild-text', guild: { id: 'guild-test', name: 'Test' } },
    }))).outcome).toBe('ignored');
    expect(port.slashResponses).toHaveLength(0);
  });
  it('allows slash commands in the exact test guild and channel', async () => {
    const { bot, port } = setup();
    const result = await bot.handleSlashAsk(slashAsk({
      channel: { id: 'ai-test', kind: 'guild-text', guild: { id: 'guild-test', name: 'Test' } },
      question: 'What can you help with?',
    }));
    expect(result.outcome).toBe('responded');
    expect(port.slashResponses).toHaveLength(1);
  });
  it('ignores DMs when a test guild is scoped', async () => {
    const { bot, port } = setup();
    expect((await bot.handleMessage(guildMessage({
      content: '<@bot-user-id> hello', mentionedUserIds: ['bot-user-id'],
      channel: { id: 'ai-test', kind: 'dm' },
    }))).outcome).toBe('ignored');
    expect(port.sentMessages).toHaveLength(0);
  });
});
