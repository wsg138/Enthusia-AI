import { describe, expect, it } from 'vitest';
import type { REST } from 'discord.js';
import { upsertAiSlashCommand } from '../src/discord-js-client.js';

function capture() {
  const calls: Array<{ path: string; body: unknown }> = [];
  // The test uses a fake REST surface; no token, login, or Discord HTTP.
  const rest = {
    post: async (path: string, options: { body: unknown }) => {
      calls.push({ path, body: options.body });
      return { id: 'fake-command' };
    },
  } as unknown as Pick<REST, 'post'>;
  return { rest, calls };
}

describe('Non-destructive /ai command registration', () => {
  it('upserts only /ai to the selected test guild', async () => {
    const { rest, calls } = capture();
    await upsertAiSlashCommand(rest, 'app-123', 'guild-456');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/applications/app-123/guilds/guild-456/commands');
    const body = calls[0]?.body as { name: string; options: Array<{ name: string }> };
    expect(body.name).toBe('ai');
    expect(body.options[0]?.name).toBe('ask');
    expect(Array.isArray(calls[0]?.body)).toBe(false);
  });

  it('upserts only /ai in global mode without replacing other commands', async () => {
    const { rest, calls } = capture();
    await upsertAiSlashCommand(rest, 'app-123');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/applications/app-123/commands');
    expect((calls[0]?.body as { name: string }).name).toBe('ai');
    expect(Array.isArray(calls[0]?.body)).toBe(false);
  });

  it('propagates registration failure instead of silently starting bot', async () => {
    const rest = {
      post: async () => { throw new Error('Forbidden'); },
    } as unknown as Pick<REST, 'post'>;
    await expect(upsertAiSlashCommand(rest, 'app-123', 'guild-456'))
      .rejects.toThrow('Forbidden');
  });
});
