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
      ticketEvidenceEnabled: false,
      ticketWebhookConfigured: false,
      ticketEvidencePolicyConfigured: false,
      staffModerationConfigured: false,
      staffModerationTimeoutMs: 10_000,
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

  it('fails closed when ticket evidence is enabled without its complete bounded dependency set', () => {
    expect(() =>
      loadAgentServiceConfig({
        NODE_ENV: 'test',
        ENTHUSIA_AGENT_TICKET_EVIDENCE_ENABLED: 'true',
      }),
    ).toThrow(/configuration is incomplete/);
  });

  it('accepts a complete ticket evidence configuration and redacts every secret/path', () => {
    const config = loadAgentServiceConfig({
      NODE_ENV: 'test',
      ENTHUSIA_AGENT_SFTP_CONFIG_PATH: '/run/private/live-sftp.json',
      ENTHUSIA_AGENT_TICKET_BOT_BASE_URL: 'http://127.0.0.1:8791',
      ENTHUSIA_AGENT_TICKET_BOT_API_KEY: 'ticket-bot-secret-value-that-is-long-enough',
      ENTHUSIA_AGENT_TICKET_EVIDENCE_ENABLED: 'true',
      ENTHUSIA_AGENT_TICKET_WEBHOOK_SECRET:
        'ticket-webhook-secret-value-that-is-long-enough',
      ENTHUSIA_AGENT_TICKET_EVIDENCE_POLICY_SERVER_ID: 'smp',
      ENTHUSIA_AGENT_TICKET_EVIDENCE_POLICY_SOURCE_ID:
        'enthusia-staff-reason-policies',
      ENTHUSIA_AGENT_STAFF_MODERATION_BASE_URL: 'http://127.0.0.1:8767',
      ENTHUSIA_AGENT_STAFF_MODERATION_API_KEY:
        'staff-moderation-secret-value-that-is-long-enough',
      ENTHUSIA_AGENT_STAFF_MODERATION_TIMEOUT_MS: '3200',
    });

    expect(config.ticketEvidenceEnabled).toBe(true);
    const redacted = redactedAgentServiceConfig(config);
    expect(redacted).toMatchObject({
      ticketEvidenceEnabled: true,
      ticketWebhookConfigured: true,
      ticketEvidencePolicyConfigured: true,
      staffModerationConfigured: true,
      staffModerationTimeoutMs: 3200,
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('ticket-bot-secret-value');
    expect(serialized).not.toContain('ticket-webhook-secret-value');
    expect(serialized).not.toContain('staff-moderation-secret-value');
    expect(serialized).not.toContain('/run/private');
    expect(serialized).not.toContain('enthusia-staff-reason-policies');
  });

  it('fails closed when only half of the Staff moderation credential pair is set', () => {
    expect(() =>
      loadAgentServiceConfig({
        NODE_ENV: 'test',
        ENTHUSIA_AGENT_STAFF_MODERATION_BASE_URL: 'http://127.0.0.1:8767',
      }),
    ).toThrow('must be configured together');

    expect(() =>
      loadAgentServiceConfig({
        NODE_ENV: 'test',
        ENTHUSIA_AGENT_STAFF_MODERATION_API_KEY: 'staff-secret',
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
