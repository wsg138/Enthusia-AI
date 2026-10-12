import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { waitForDiscordClientReady } from '../src/discord-js-client.js';

class FakeDiscordGateway extends EventEmitter {
  ready = false;

  isReady(): boolean {
    return this.ready;
  }

  becomeReady(): void {
    this.ready = true;
    this.emit(Events.ClientReady);
  }
}

describe('Discord gateway readiness before command registration', () => {
  it('does not wait when the gateway already is ready', async () => {
    const gateway = new FakeDiscordGateway();
    gateway.becomeReady();
    await waitForDiscordClientReady(gateway, 30);
    expect(gateway.listenerCount(Events.ClientReady)).toBe(0);
  });

  it('waits for the asynchronous ClientReady event after login', async () => {
    const gateway = new FakeDiscordGateway();
    let completed = false;
    const waiting = waitForDiscordClientReady(gateway, 1000).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(gateway.listenerCount(Events.ClientReady)).toBe(1);
    gateway.becomeReady();
    await waiting;
    expect(completed).toBe(true);
    expect(gateway.listenerCount(Events.ClientReady)).toBe(0);
  });

  it('times out cleanly and removes its listener if Discord never becomes ready', async () => {
    const gateway = new FakeDiscordGateway();
    await expect(waitForDiscordClientReady(gateway, 5)).rejects.toThrow('startup timeout');
    expect(gateway.listenerCount(Events.ClientReady)).toBe(0);
  });
});
