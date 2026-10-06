import { describe, expect, it } from 'vitest';
import {
  loadConfiguredSftpRuntime,
  loadConfiguredTicketRuntime,
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


describe('production evidence runtime handles', () => {
  it('returns no clients when Ticket Bot is disabled', () => {
    expect(loadConfiguredTicketRuntime({ timeoutMs: 10_000 })).toEqual({
      tools: [],
    });
  });

  it('provides lifecycle and evidence clients only with the complete Ticket Bot pair', () => {
    const runtime = loadConfiguredTicketRuntime({
      baseUrl: 'http://127.0.0.1:8791',
      apiKey: 'test-only-key',
      timeoutMs: 10_000,
    });
    expect(runtime.client).toBeDefined();
    expect(runtime.evidenceClient).toBeDefined();
    expect(runtime.tools.map((tool) => tool.meta.name).sort()).toEqual([
      'ticket.capabilities',
      'ticket.get_context',
      'ticket.request_close',
      'ticket.request_escalation',
    ]);
  });

  it('returns no live source gateway when SFTP is disabled', async () => {
    await expect(loadConfiguredSftpRuntime(undefined)).resolves.toEqual({
      tools: [],
    });
  });
});
