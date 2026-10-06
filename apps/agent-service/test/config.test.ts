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
      memoryConfigured: false,
      ticketBotConfigured: false,
      ticketBotTimeoutMs: 10_000,
    });
  });

  it('redacts the familiarity memory path', () => {
    const config = loadAgentServiceConfig({
      NODE_ENV: 'test',
      ENTHUSIA_AGENT_MEMORY_PATH: '/srv/private/state/agent-memory.sqlite',
    });
    const redacted = redactedAgentServiceConfig(config);
    expect(redacted).toMatchObject({ memoryConfigured: true });
    expect(JSON.stringify(redacted)).not.toContain('/srv/private/state');
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

  it('fails closed for partial ticket evidence review configuration', () => {
    expect(() =>
      loadAgentServiceConfig({
        NODE_ENV: 'test',
        ENTHUSIA_AGENT_STAFF_MODERATION_BASE_URL: 'http://127.0.0.1:8767',
      }),
    ).toThrow(/requires Staff moderation URL\/key and policy server\/source/);

    expect(() =>
      loadAgentServiceConfig({
        NODE_ENV: 'test',
        ENTHUSIA_AGENT_STAFF_MODERATION_BASE_URL: 'http://127.0.0.1:8767',
        ENTHUSIA_AGENT_STAFF_MODERATION_API_KEY: 'staff-secret',
        ENTHUSIA_AGENT_POLICY_SERVER_ID: 'smp',
        ENTHUSIA_AGENT_POLICY_SOURCE_ID: 'enthusia-staff-reason-policies',
      }),
    ).toThrow(/requires the Ticket Bot runtime configuration/);
  });

  it('accepts complete evidence review wiring while redacting secrets and source ids', () => {
    const config = loadAgentServiceConfig({
      NODE_ENV: 'test',
      ENTHUSIA_AGENT_SFTP_CONFIG_PATH: '/srv/private/live-sources.json',
      ENTHUSIA_AGENT_TICKET_BOT_BASE_URL: 'http://127.0.0.1:8791',
      ENTHUSIA_AGENT_TICKET_BOT_API_KEY: 'ticket-secret',
      ENTHUSIA_AGENT_STAFF_MODERATION_BASE_URL: 'http://127.0.0.1:8767',
      ENTHUSIA_AGENT_STAFF_MODERATION_API_KEY: 'staff-secret',
      ENTHUSIA_AGENT_STAFF_MODERATION_TIMEOUT_MS: '3500',
      ENTHUSIA_AGENT_POLICY_SERVER_ID: 'smp',
      ENTHUSIA_AGENT_POLICY_SOURCE_ID: 'enthusia-staff-reason-policies',
    });
    const redacted = redactedAgentServiceConfig(config);
    expect(redacted).toMatchObject({
      staffModerationConfigured: true,
      staffModerationTimeoutMs: 3500,
      policySourceConfigured: true,
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('ticket-secret');
    expect(serialized).not.toContain('staff-secret');
    expect(serialized).not.toContain('enthusia-staff-reason-policies');
    expect(serialized).not.toContain('/srv/private');
  });
});
