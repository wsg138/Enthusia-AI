import { describe, expect, it } from 'vitest';
import { Visibility, type AgentResponse, type ChatRequest } from '@enthusia/contracts';
import { formatRichAgentResponse } from '../src/rich-formatting.js';
import { EnthusiaAiDiscordBot } from '../src/bot.js';
import type { DiscordMessageRef, DiscordRichResponse } from '../src/types.js';
import { MockDiscordClientPort, guildMessage, slashAsk, testOptions, nullLogger } from './mock-port.js';

const SHA = 'a'.repeat(40);
const URL = 'https://github.com/wsg138/PieCloak/blob/' + SHA + '/README.md';
function sourceAnswer(traceId = 'test'): AgentResponse {
  return {
    text: '**PieCloak helps hide your base.**\n\n**How it works**\n' +
      '• **Under 24 blocks:** Those clues are visible.\n' +
      '• **24–48 blocks:** Clues behind 3 blocking samples are hidden.\n' +
      '• **Over 48 blocks:** Those clues stay hidden.\n' +
      '_These are documented settings, not a live-server health check._\n' +
      'Source: ' + URL + '\nDocumentation revision: aaaaaaaaaaaa.',
    sources: [{
      artifactId: 'github:wsg138/PieCloak@' + SHA + ':README.md',
      description: 'Verified public README', visibility: Visibility.PUBLIC,
    }],
    actions: [], memoryUpdates: [], escalation: null, traceId,
  };
}

class RichTestPort extends MockDiscordClientPort {
  readonly richMessages: Array<{ message: DiscordRichResponse; replyTo?: string }> = [];
  readonly richSlashes: DiscordRichResponse[] = [];
  readonly reactions: string[] = [];
  failReactions = false;
  async sendRichMessage(_channel: string, card: DiscordRichResponse, replyTo?: string): Promise<string> {
    this.richMessages.push({ message: card, ...(replyTo ? { replyTo } : {}) });
    return 'rich-1';
  }
  async respondToSlashAskRich(_interaction: unknown, card: DiscordRichResponse): Promise<void> {
    this.richSlashes.push(card);
  }
  async addMessageReaction(_message: DiscordMessageRef, emoji: string): Promise<void> {
    this.reactions.push('+' + emoji);
    if (this.failReactions) throw new Error('Missing Permissions');
  }
  async removeMessageReaction(_message: DiscordMessageRef, emoji: string): Promise<void> {
    this.reactions.push('-' + emoji);
    if (this.failReactions) throw new Error('Missing Permissions');
  }
}

function botFor(port: RichTestPort, allowed = true) {
  const gateway = {
    sendChat: async (request: ChatRequest) => sourceAnswer(request.traceId),
  };
  const bot = new EnthusiaAiDiscordBot(port, gateway, testOptions({
    mentionOnly: true,
    allowedGuildIds: allowed ? ['test-guild'] : [],
    allowedChannelIds: allowed ? ['ai-testing'] : [],
  }), nullLogger());
  const message = guildMessage({
    content: '<@bot-user-id> How does PieCloak work?',
    mentionedUserIds: ['bot-user-id'],
    channel: { id: 'ai-testing', kind: 'guild-text', guild: { id: 'test-guild', name: 'Testing' } },
  });
  return { bot, message };
}

describe('clean verified-answer embeds', () => {
  it('keeps the long commit URL hidden in an embed field', () => {
    const result = formatRichAgentResponse(sourceAnswer());
    expect(result?.embed.title).toContain('PieCloak');
    expect(result?.embed.description).toContain('24–48 blocks');
    expect(result?.embed.description).not.toContain('https://');
    expect(result?.embed.fields?.[0]?.value).toContain('[Enthusia Wiki](https://enthusia.miraheze.org/wiki/Main_Page)');
    expect(result?.embed.fields?.[0]?.value).toContain('[Technical source](' + URL + ')');
    expect(result?.embed.footer?.text).toContain('not verified');
  });
  it('never formats forged or unverified source links as verified citations', () => {
    const answer = sourceAnswer();
    answer.sources = [];
    const result = formatRichAgentResponse(answer);
    expect(result?.embed.fields).toBeUndefined();
  });
  it('never sends mass mentions through embeds', () => {
    const answer = sourceAnswer();
    answer.text = 'Hello @everyone and @here';
    const result = formatRichAgentResponse(answer);
    expect(result?.embed.description).not.toContain('@everyone');
    expect(result?.embed.description).not.toContain('@here');
  });
  it('leaves very long messages to the pre-existing splitter', () => {
    const answer = sourceAnswer();
    answer.text = 'x'.repeat(4500);
    expect(formatRichAgentResponse(answer)).toBeNull();
  });
});

describe('mention lifecycle in isolated test channel', () => {
  it('sends an embed and transitions 👀 → 🤔 → ✅', async () => {
    const port = new RichTestPort();
    const { bot, message } = botFor(port);
    const outcome = await bot.handleMessage(message);
    expect(outcome.outcome).toBe('responded');
    expect(port.richMessages).toHaveLength(1);
    expect(port.richMessages[0]?.replyTo).toBe(message.id);
    expect(port.sentMessages).toHaveLength(0);
    expect(port.reactions).toEqual(['+👀', '-👀', '+🤔', '-👀', '-🤔', '+✅']);
  });
  it('does not react to unrelated messages even inside the allowlisted channel', async () => {
    const port = new RichTestPort();
    const { bot, message } = botFor(port);
    const outcome = await bot.handleMessage({ ...message, mentionedUserIds: [], content: 'What is PieCloak?' });
    expect(outcome.outcome).toBe('ignored');
    expect(port.reactions).toEqual([]);
    expect(port.richMessages).toEqual([]);
  });
  it('cannot react or respond outside the approved guild or channel', async () => {
    const port = new RichTestPort();
    const { bot, message } = botFor(port);
    const wrong = { ...message, channel: {
      id: 'ticket-logs', kind: 'guild-text' as const,
      guild: { id: 'test-guild', name: 'Testing' },
    } };
    expect((await bot.handleMessage(wrong)).outcome).toBe('ignored');
    expect(port.reactions).toEqual([]);
    expect(port.richMessages).toEqual([]);
  });
  it('keeps answering even if it has no reaction permissions', async () => {
    const port = new RichTestPort();
    port.failReactions = true;
    const { bot, message } = botFor(port);
    expect((await bot.handleMessage(message)).outcome).toBe('responded');
    expect(port.richMessages).toHaveLength(1);
  });
  it('uses an error reaction if the Gateway fails, without leaving thinking behind', async () => {
    const port = new RichTestPort();
    const failingGateway = { sendChat: async () => { throw new Error('synthetic gateway outage'); } };
    const bot = new EnthusiaAiDiscordBot(port, failingGateway, testOptions({
      mentionOnly: true,
      allowedGuildIds: ['test-guild'],
      allowedChannelIds: ['ai-testing'],
    }), nullLogger());
    const { message } = botFor(port);
    const result = await bot.handleMessage(message);
    expect(result.outcome).toBe('gateway-error');
    expect(port.reactions).toEqual(['+👀', '-👀', '+🤔', '-👀', '-🤔', '+❌']);
    expect(port.richMessages).toHaveLength(0);
    expect(port.sentMessages).toHaveLength(1);
    expect(port.sentMessages[0]?.message.content).not.toContain('synthetic gateway outage');
  });

  it('reacts ❌ to a structured Agent error despite HTTP 200 and a valid embed', async () => {
    const port = new RichTestPort();
    const response = sourceAnswer();
    response.outcome = 'error';
    response.text = 'I could not finish that request. Please try again in a moment.';
    const bot = new EnthusiaAiDiscordBot(port,
      { sendChat: async () => response },
      testOptions({ mentionOnly: true, allowedGuildIds: ['test-guild'], allowedChannelIds: ['ai-testing'] }),
      nullLogger());
    const { message } = botFor(port);
    const result = await bot.handleMessage(message);
    expect(result.outcome).toBe('agent-error');
    expect(port.reactions.at(-1)).toBe('+❌');
    expect(port.richMessages).toHaveLength(1);
  });

  it('reacts ⚠️ for source-limited answers rather than claiming full success', async () => {
    const port = new RichTestPort();
    const response = sourceAnswer();
    response.outcome = 'unverified';
    response.sources = [];
    response.text = 'I could not verify the rules from current sources.';
    const bot = new EnthusiaAiDiscordBot(port,
      { sendChat: async () => response },
      testOptions({ mentionOnly: true, allowedGuildIds: ['test-guild'], allowedChannelIds: ['ai-testing'] }),
      nullLogger());
    const { message } = botFor(port);
    const result = await bot.handleMessage(message);
    expect(result.outcome).toBe('unverified');
    expect(port.reactions.at(-1)).toBe('+⚠️');
    expect(port.richMessages).toHaveLength(1);
  });

  it('renders an exact-commit Warzones technical source with no raw URL preview', () => {
    const response = sourceAnswer();
    response.sources = [{
      artifactId: 'github:wsg138/MaceGuard@' + SHA + ':README.md',
      description: 'Public Warzones documentation',
      visibility: Visibility.PUBLIC,
    }];
    response.text = '**Warzones** rotate kits and modifiers.\nSource: ' +
      'https://github.com/wsg138/MaceGuard/blob/' + SHA + '/README.md' +
      '\nDocumentation revision: aaaaaaaaaaaa.';
    const card = formatRichAgentResponse(response);
    expect(card?.embed.title).toContain('Warzones');
    expect(card?.embed.description).not.toContain('https://');
    expect(card?.embed.fields?.[0]?.value).toContain(
      '[Technical source](https://github.com/wsg138/MaceGuard/blob/' + SHA + '/README.md)');
  });

  it('falls back to plain text if Discord refuses the embed permission', async () => {
    const port = new RichTestPort();
    port.sendRichMessage = async () => { throw new Error('Missing Embed Links permission'); };
    const { bot, message } = botFor(port);
    const result = await bot.handleMessage(message);
    expect(result.outcome).toBe('responded');
    expect(port.sentMessages).toHaveLength(1);
    expect(port.sentMessages[0]?.message.content).toContain('PieCloak');
    expect(port.reactions.at(-1)).toBe('+✅');
  });

  it('renders /ai ask as a rich reply without status reactions', async () => {
    const port = new RichTestPort();
    const { bot } = botFor(port);
    const interaction = slashAsk({
      channel: { id: 'ai-testing', kind: 'guild-text', guild: { id: 'test-guild', name: 'Testing' } },
      question: 'How does PieCloak work?',
    });
    expect((await bot.handleSlashAsk(interaction)).outcome).toBe('responded');
    expect(port.richSlashes).toHaveLength(1);
    expect(port.richSlashes[0]?.embed.title).toContain('PieCloak');
    expect(port.reactions).toEqual([]);
  });
});
