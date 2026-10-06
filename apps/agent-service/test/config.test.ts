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
