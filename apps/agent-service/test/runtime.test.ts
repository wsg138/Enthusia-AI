import { describe, expect, it } from 'vitest';
import type { InferenceClient } from '@enthusia/inference-adapter';
import type { LiveServerSourceGateway } from '@enthusia/integration-sftp';
import {
  loadConfiguredTicketEvidenceReview,
  loadConfiguredTicketTools,
} from '../src/runtime.js';

describe('production Ticket Bot tool registration', () => {
  it('registers nothing when Ticket Bot is disabled', () => {
    expect(loadConfiguredTicketTools({ timeoutMs: 10_000 })).toEqual([]);
  });

  it('fails closed for incomplete runtime configuration', () => {
    expect(() =>
      loadConfiguredTicketTools({
        baseUrl: 'http://127.0.0.1:8791',
        timeoutMs: 10_000,
      }),
    ).toThrow('configuration is incomplete');
  });

  it('registers only the bounded W14 Ticket Bot tools', () => {
    const tools = loadConfiguredTicketTools({
      baseUrl: 'http://127.0.0.1:8791',
      apiKey: 'test-only-key',
      timeoutMs: 10_000,
    });
    expect(tools.map((tool) => tool.meta.name).sort()).toEqual([
      'ticket.capabilities',
      'ticket.get_context',
      'ticket.request_close',
      'ticket.request_escalation',
    ]);
  });
});


describe('production ticket evidence review registration', () => {
  const inference = {
    async complete() {
      throw new Error('not used during composition');
    },
  } as unknown as Pick<InferenceClient, 'complete'>;

  it('stays disabled when Staff moderation review is not configured', () => {
    expect(
      loadConfiguredTicketEvidenceReview(
        {
          ticketBotTimeoutMs: 10_000,
          staffModerationTimeoutMs: 10_000,
        },
        undefined,
        inference,
      ),
    ).toBeUndefined();
  });

  it('fails closed if the runtime dependencies are incomplete', () => {
    expect(() =>
      loadConfiguredTicketEvidenceReview(
        {
          ticketBotBaseUrl: 'http://127.0.0.1:8791',
          ticketBotApiKey: 'ticket-test-key',
          ticketBotTimeoutMs: 10_000,
          staffModerationBaseUrl: 'http://127.0.0.1:8767',
          staffModerationApiKey: 'staff-test-key',
          staffModerationTimeoutMs: 10_000,
          policyServerId: 'smp',
          policySourceId: 'enthusia-staff-reason-policies',
        },
        undefined,
        inference,
      ),
    ).toThrow('configuration is incomplete');
  });

  it('constructs the composed service only when every dependency is present', () => {
    const gateway = {} as LiveServerSourceGateway;
    const service = loadConfiguredTicketEvidenceReview(
      {
        ticketBotBaseUrl: 'http://127.0.0.1:8791',
        ticketBotApiKey: 'ticket-test-key',
        ticketBotTimeoutMs: 10_000,
        staffModerationBaseUrl: 'http://127.0.0.1:8767',
        staffModerationApiKey: 'staff-test-key',
        staffModerationTimeoutMs: 10_000,
        policyServerId: 'smp',
        policySourceId: 'enthusia-staff-reason-policies',
      },
      gateway,
      inference,
    );
    expect(service).toBeDefined();
  });
});
