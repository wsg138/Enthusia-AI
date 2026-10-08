/**
 * Tests for W06-owned configuration resolution: safe defaults and
 * environment overrides.
 */
import { Visibility } from '@enthusia/contracts';
import { describe, expect, it } from 'vitest';

import { resolveDiscordBotOptions } from '../src/config.js';

describe('resolveDiscordBotOptions', () => {
  it('has safe defaults with an empty environment', () => {
    const options = resolveDiscordBotOptions({});
    expect(options.botName).toBe('Enthusia AI');
    expect(options.gatewayBaseUrl).toBe('http://127.0.0.1:4100');
    expect(options.useMockGateway).toBe(false);
    expect(options.slashOnly).toBe(false);
    expect(options.aiChannelIds).toEqual([]);
    expect(options.testChannelIds).toEqual([]);
    expect(options.staffChannelIds).toEqual([]);
    expect(options.staffRoleIds).toEqual([]);
    expect(options.defaultVisibilityCeiling).toBe(Visibility.PUBLIC);
    expect(options.maxMessageChars).toBe(2000);
  });

  it('parses comma-separated channel and role lists', () => {
    const options = resolveDiscordBotOptions({
      ENTHUSIA_DISCORD_TEST_CHANNELS: 'chan-1, chan-2 ,,',
      ENTHUSIA_DISCORD_AI_CHANNELS: 'ai-1',
      ENTHUSIA_DISCORD_STAFF_CHANNELS: 'staff-1',
      ENTHUSIA_DISCORD_STAFF_ROLES: 'role-1,role-2',
    });
    expect(options.testChannelIds).toEqual(['chan-1', 'chan-2']);
    expect(options.aiChannelIds).toEqual(['ai-1']);
    expect(options.staffChannelIds).toEqual(['staff-1']);
    expect(options.staffRoleIds).toEqual(['role-1', 'role-2']);
  });

  it('reads gateway and rate-limit overrides', () => {
    const options = resolveDiscordBotOptions({
      ENTHUSIA_AI_GATEWAY_URL: 'http://gateway:4100',
      ENTHUSIA_AI_GATEWAY_API_KEY: 'gateway-secret',
      ENTHUSIA_DISCORD_USE_MOCK_GATEWAY: 'false',
      ENTHUSIA_DISCORD_GATEWAY_TIMEOUT_MS: '5000',
      ENTHUSIA_DISCORD_PER_USER_LIMIT: '10',
      ENTHUSIA_DISCORD_BOT_NAME: 'TestBot',
      ENTHUSIA_DISCORD_SLASH_GUILD_ID: 'guild-9',
    });
    expect(options.gatewayBaseUrl).toBe('http://gateway:4100');
    expect(options.gatewayApiKey).toBe('gateway-secret');
    expect(options.useMockGateway).toBe(false);
    expect(options.gatewayTimeoutMs).toBe(5000);
    expect(options.perUserRateLimit.maxRequests).toBe(10);
    expect(options.botName).toBe('TestBot');
    expect(options.slashCommandGuildId).toBe('guild-9');
  });

  it('allows the isolated Discord client to wait longer than a slow local model', () => {
    const options = resolveDiscordBotOptions({
      ENTHUSIA_DISCORD_GATEWAY_TIMEOUT_MS: '130000',
    });
    expect(options.gatewayTimeoutMs).toBe(130000);
  });

  it('falls back to defaults on invalid numbers', () => {
    const options = resolveDiscordBotOptions({ ENTHUSIA_DISCORD_PER_USER_LIMIT: 'banana' });
    expect(options.perUserRateLimit.maxRequests).toBe(5);
  });
});
