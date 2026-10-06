import { describe, expect, it } from 'vitest';
import {
  loadConfiguredSftpRuntime,
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


describe('production SFTP runtime composition', () => {
  it('exposes no gateway when live SFTP is disabled', async () => {
    const runtime = await loadConfiguredSftpRuntime(undefined, {});
    expect(runtime.tools).toEqual([]);
    expect(runtime.gateway).toBeUndefined();
  });
});
