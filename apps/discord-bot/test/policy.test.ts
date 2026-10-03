/**
 * Tests for the trigger policy: the bot responds ONLY to explicit mentions,
 * /ai slash commands, and messages in configured test/AI channels — never to
 * broad automatic interception, and never to bots (including itself).
 */
import { describe, expect, it } from 'vitest';

import { decideSlashTrigger, decideTrigger, extractPrompt } from '../src/policy.js';
import { guildMessage, testOptions } from './mock-port.js';

const BOT_ID = 'bot-user-id';

describe('extractPrompt', () => {
  it('strips <@id> mention markup', () => {
    expect(extractPrompt(`<@${BOT_ID}> what is the ip?`, BOT_ID)).toBe('what is the ip?');
  });

  it('strips <@!id> nickname mention markup', () => {
    expect(extractPrompt(`<@!${BOT_ID}> hello`, BOT_ID)).toBe('hello');
  });

  it('collapses whitespace left by removed mentions', () => {
    expect(extractPrompt(`hello <@${BOT_ID}>   world`, BOT_ID)).toBe('hello world');
  });

  it('returns empty string for a bare mention', () => {
    expect(extractPrompt(`<@${BOT_ID}>`, BOT_ID)).toBe('');
  });
});

describe('decideTrigger', () => {
  it('triggers on an explicit mention', () => {
    const decision = decideTrigger(
      guildMessage({ content: `<@${BOT_ID}> what is the ip?`, mentionedUserIds: [BOT_ID] }),
      BOT_ID,
      testOptions(),
    );
    expect(decision.trigger).toBe('mention');
    expect(decision.prompt).toBe('what is the ip?');
  });

  it('ignores messages from bots', () => {
    const decision = decideTrigger(
      guildMessage({
        content: `<@${BOT_ID}> hello`,
        mentionedUserIds: [BOT_ID],
        author: { id: 'other-bot', username: 'other', isBot: true },
      }),
      BOT_ID,
      testOptions(),
    );
    expect(decision.trigger).toBeNull();
    expect(decision.reason).toContain('bot');
  });

  it('ignores its own messages', () => {
    const decision = decideTrigger(
      guildMessage({
        content: 'hello',
        author: { id: BOT_ID, username: 'Enthusia AI', isBot: true },
      }),
      BOT_ID,
      testOptions(),
    );
    expect(decision.trigger).toBeNull();
  });

  it('ignores ordinary messages with no trigger', () => {
    const decision = decideTrigger(
      guildMessage({ content: 'just chatting here' }),
      BOT_ID,
      testOptions(),
    );
    expect(decision.trigger).toBeNull();
    expect(decision.reason).toContain('no trigger');
  });

  it('triggers on messages in the configured test channel (no mention needed)', () => {
    const decision = decideTrigger(
      guildMessage({ content: 'test question', channel: { id: 'test-chan', kind: 'guild-text' } }),
      BOT_ID,
      testOptions({ testChannelIds: ['test-chan'] }),
    );
    expect(decision.trigger).toBe('test-channel');
    expect(decision.prompt).toBe('test question');
  });

  it('triggers on messages in a configured AI channel', () => {
    const decision = decideTrigger(
      guildMessage({ content: 'help me', channel: { id: 'ai-chan', kind: 'guild-text' } }),
      BOT_ID,
      testOptions({ aiChannelIds: ['ai-chan'] }),
    );
    expect(decision.trigger).toBe('ai-channel');
  });

  it('prefers the mention trigger over channel triggers', () => {
    const decision = decideTrigger(
      guildMessage({
        content: `<@${BOT_ID}> hi`,
        mentionedUserIds: [BOT_ID],
        channel: { id: 'test-chan', kind: 'guild-text' },
      }),
      BOT_ID,
      testOptions({ testChannelIds: ['test-chan'] }),
    );
    expect(decision.trigger).toBe('mention');
    expect(decision.prompt).toBe('hi');
  });

  it('does not mistake another user mention for the bot', () => {
    const decision = decideTrigger(
      guildMessage({ content: '<@someone-else> hi', mentionedUserIds: ['someone-else'] }),
      BOT_ID,
      testOptions(),
    );
    expect(decision.trigger).toBeNull();
  });

  it('still triggers on channel messages before login (botUserId null)', () => {
    const decision = decideTrigger(
      guildMessage({ content: 'hi', channel: { id: 'test-chan', kind: 'guild-text' } }),
      null,
      testOptions({ testChannelIds: ['test-chan'] }),
    );
    expect(decision.trigger).toBe('test-channel');
  });
});

describe('decideSlashTrigger', () => {
  it('is always an explicit trigger', () => {
    const decision = decideSlashTrigger('  what is the ip? ');
    expect(decision.trigger).toBe('slash');
    expect(decision.prompt).toBe('what is the ip?');
  });
});
