import { describe, expect, it } from 'vitest';
import {
  loadAgentServiceConfig,
  redactedAgentServiceConfig,
} from '../src/config.js';

describe('agent-service Ticket Bot configuration', () => {
  it('leaves Ticket Bot tools disabled when no backend is configured', () => {
    const config = loadAgentServiceConfig({ NODE_ENV: 'test' });
    expect(config.ticketBotBaseUrl).toBeUndefined();
    expect(config.ticketBotApiKey).toBeUndefined();
    expect(redactedAgentServiceConfig(config)).toMatchObject({
      ticketBotConfigured: false,
      ticketBotTimeoutMs: 10_000,
    });
  });

  it('enables persistent familiarity memory only when an explicit path is configured', () => {
    const disabled = loadAgentServiceConfig({ NODE_ENV: 'test' });
    expect(disabled.memoryDbPath).toBeUndefined();
    expect(redactedAgentServiceConfig(disabled)).toMatchObject({
      memoryConfigured: false,
    });

    const enabled = loadAgentServiceConfig({
      NODE_ENV: 'test',
      ENTHUSIA_AGENT_MEMORY_DB_PATH: '/run/enthusia-ai/memory.sqlite',
    });
    expect(enabled.memoryDbPath).toBe('/run/enthusia-ai/memory.sqlite');
    const redacted = redactedAgentServiceConfig(enabled);
    expect(redacted).toMatchObject({ memoryConfigured: true });
    expect(JSON.stringify(redacted)).not.toContain('/run/enthusia-ai/memory.sqlite');
  });

  it('fails closed when only half of the Ticket Bot credential pair is set', () => {
    expect(() =>
      loadAgentServiceConfig({
        NODE_ENV: 'test',
        ENTHUSIA_AGENT_TICKET_BOT_BASE_URL: 'http://127.0.0.1:8791',
      }),
    ).toThrow('must be configured together');

    expect(() =>
      loadAgentServiceConfig({
        NODE_ENV: 'test',
        ENTHUSIA_AGENT_TICKET_BOT_API_KEY: 'secret-value',
      }),
    ).toThrow('must be configured together');
  });

  it('redacts the Ticket Bot API key completely', () => {
    const config = loadAgentServiceConfig({
      NODE_ENV: 'test',
      ENTHUSIA_AGENT_TICKET_BOT_BASE_URL: 'http://127.0.0.1:8791',
      ENTHUSIA_AGENT_TICKET_BOT_API_KEY: 'never-log-this',
      ENTHUSIA_AGENT_TICKET_BOT_TIMEOUT_MS: '2500',
    });
    const redacted = redactedAgentServiceConfig(config);
    expect(redacted).toMatchObject({
      ticketBotConfigured: true,
      ticketBotTimeoutMs: 2500,
    });
    expect(JSON.stringify(redacted)).not.toContain('never-log-this');
  });
});
