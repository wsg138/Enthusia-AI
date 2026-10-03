/**
 * Tests for Discord response formatting: mass-mention neutralization,
 * 2000-char chunking with paragraph preference, code-fence safety, and the
 * truncation cap.
 */
import { describe, expect, it } from 'vitest';

import {
  DISCORD_MAX_MESSAGE_CHARS,
  formatAgentResponse,
  neutralizeMassMentions,
  splitIntoDiscordMessages,
} from '../src/formatting.js';
import type { AgentResponse } from '@enthusia/contracts';

function agentResponse(text: string): AgentResponse {
  return {
    text,
    actions: [],
    sources: [],
    memoryUpdates: [],
    escalation: null,
    traceId: 'trace-1',
  };
}

describe('neutralizeMassMentions', () => {
  it('breaks @everyone and @here with a zero-width space', () => {
    const out = neutralizeMassMentions('hello @everyone and @here');
    expect(out).not.toContain('@everyone');
    expect(out).not.toContain('@here');
    expect(out).toContain('everyone');
  });

  it('leaves ordinary mentions alone', () => {
    expect(neutralizeMassMentions('hi <@123>')).toBe('hi <@123>');
  });
});

describe('splitIntoDiscordMessages', () => {
  it('returns short text as a single chunk', () => {
    expect(splitIntoDiscordMessages('hello world')).toEqual(['hello world']);
  });

  it('returns no chunks for empty text', () => {
    expect(splitIntoDiscordMessages('   \n  ')).toEqual([]);
  });

  it('never exceeds the max length', () => {
    const text = 'word '.repeat(2000); // 10_000 chars
    const chunks = splitIntoDiscordMessages(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_CHARS);
    }
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim().length).toBeGreaterThan(9000);
  });

  it('prefers paragraph breaks', () => {
    const para = 'a'.repeat(1500);
    const chunks = splitIntoDiscordMessages(`${para}\n\n${para}`, 2000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(para);
    expect(chunks[1]).toBe(para);
  });

  it('hard-splits overlong words without a clean break', () => {
    const long = 'x'.repeat(5000);
    const chunks = splitIntoDiscordMessages(long, 2000);
    // 4 chars are reserved for a potential fence open/close so the hard
    // 2000-char cap always holds.
    expect(chunks).toEqual(['x'.repeat(1996), 'x'.repeat(1996), 'x'.repeat(1008)]);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('never leaves a chunk ending inside a code fence', () => {
    const fence = '```python\n' + 'print(1)\n'.repeat(300) + '```';
    const before = 'Here is some code:\n\n';
    const after = '\n\nHope that helps!';
    const chunks = splitIntoDiscordMessages(before + fence + after, 500);
    for (const chunk of chunks) {
      const opens = (chunk.match(/```/g) ?? []).length;
      expect(opens % 2).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
    // The fence language survives the split.
    expect(chunks.some((chunk) => chunk.includes('```python'))).toBe(true);
  });

  it('reassembles to the original text (modulo whitespace)', () => {
    const text = 'First paragraph.\n\n```js\nconst x = 1;\n```\n\nSecond paragraph with @everyone.';
    const chunks = splitIntoDiscordMessages(text, 40);
    const normalize = (s: string): string => s.replace(/```(\w*)\n?/g, '').replace(/\s+/g, ' ').trim();
    expect(normalize(chunks.join('\n'))).toBe(normalize(neutralizeMassMentions(text)));
  });

  it('caps the chunk count and appends a truncation notice', () => {
    const text = 'word '.repeat(5000);
    const chunks = splitIntoDiscordMessages(text, 2000, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toContain('truncated');
  });

  it('neutralizes mass mentions in every chunk', () => {
    const chunks = splitIntoDiscordMessages('@everyone '.repeat(500), 2000);
    for (const chunk of chunks) {
      expect(chunk).not.toContain('@everyone');
    }
  });
});

describe('formatAgentResponse', () => {
  it('formats response text into chunks', () => {
    const chunks = formatAgentResponse(agentResponse('hello'));
    expect(chunks).toEqual(['hello']);
  });

  it('falls back gracefully on empty response text', () => {
    const chunks = formatAgentResponse(agentResponse(''));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('empty response');
  });
});
