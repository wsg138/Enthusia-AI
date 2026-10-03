import { describe, expect, it } from 'vitest';
import { Visibility, chatRequestSchema } from '@enthusia/contracts';
import { loadGatewayConfig, redactedGatewayConfig } from '../src/config.js';
import { discordChatRequest, testEnv } from './helpers.js';

describe('chatRequestSchema (contract validation)', () => {
  it('accepts a Discord-shaped request', () => {
    const result = chatRequestSchema.safeParse(discordChatRequest());
    expect(result.success).toBe(true);
  });

  it('rejects unknown surfaces, empty messages, and bad visibility', () => {
    const base = discordChatRequest();
    expect(
      chatRequestSchema.safeParse({ ...base, surface: 'irc' }).success,
    ).toBe(false);
    expect(chatRequestSchema.safeParse({ ...base, message: '' }).success).toBe(false);
    expect(
      chatRequestSchema.safeParse({ ...base, visibilityCeiling: 'EVERYONE' }).success,
    ).toBe(false);
    expect(
      chatRequestSchema.safeParse({ ...base, actor: { id: '', type: 'player' } }).success,
    ).toBe(false);
    expect(
      chatRequestSchema.safeParse({ ...base, conversationId: '' }).success,
    ).toBe(false);
  });

  it('accepts every surface and actor type the gateway may serve', () => {
    const base = discordChatRequest();
    for (const surface of ['discord', 'minecraft', 'ticket', 'staff'] as const) {
      expect(chatRequestSchema.safeParse({ ...base, surface }).success).toBe(true);
    }
    for (const type of ['player', 'staff', 'system', 'unknown'] as const) {
      expect(
        chatRequestSchema.safeParse({ ...base, actor: { id: 'x', type } }).success,
      ).toBe(true);
    }
    for (const ceiling of Object.values(Visibility)) {
      const parsed = chatRequestSchema.safeParse({ ...base, visibilityCeiling: ceiling });
      expect(parsed.success).toBe(true);
    }
  });
});

describe('loadGatewayConfig', () => {
  it('applies documented defaults', () => {
    const config = loadGatewayConfig(testEnv());
    expect(config.port).toBe(4100);
    expect(config.apiKeys).toEqual([]);
    expect(config.allowedSurfaces).toEqual(['discord', 'minecraft', 'ticket', 'staff']);
    expect(config.allowedActorTypes).toEqual(['player', 'staff', 'system', 'unknown']);
    expect(config.rateLimitUserPerMin).toBe(20);
    expect(config.rateLimitGlobalPerMin).toBe(200);
    expect(config.maxMessageBytes).toBe(8192);
    expect(config.maxBodyBytes).toBe(65536);
    expect(config.agentTimeoutMs).toBe(30_000);
    expect(config.readyProbeTimeoutMs).toBe(5000);
    expect(config.serviceVersion).toBe('0.1.0');
  });

  it('reads overrides from the environment', () => {
    const config = loadGatewayConfig(
      testEnv({
        ENTHUSIA_AI_GATEWAY_PORT: '4200',
        ENTHUSIA_GATEWAY_API_KEYS: ' alpha , beta ',
        ENTHUSIA_GATEWAY_ALLOWED_SURFACES: 'discord,minecraft',
        ENTHUSIA_GATEWAY_ALLOWED_ACTOR_TYPES: 'player',
        ENTHUSIA_GATEWAY_RATE_LIMIT_USER_PER_MIN: '5',
        ENTHUSIA_GATEWAY_RATE_LIMIT_GLOBAL_PER_MIN: '50',
        ENTHUSIA_GATEWAY_MAX_MESSAGE_BYTES: '1024',
        ENTHUSIA_GATEWAY_AGENT_TIMEOUT_MS: '10000',
      }),
    );
    expect(config.port).toBe(4200);
    expect(config.apiKeys).toEqual(['alpha', 'beta']);
    expect(config.allowedSurfaces).toEqual(['discord', 'minecraft']);
    expect(config.allowedActorTypes).toEqual(['player']);
    expect(config.rateLimitUserPerMin).toBe(5);
    expect(config.rateLimitGlobalPerMin).toBe(50);
    expect(config.maxMessageBytes).toBe(1024);
    expect(config.agentTimeoutMs).toBe(10_000);
  });

  it('fails fast on invalid configuration', () => {
    expect(() =>
      loadGatewayConfig(testEnv({ ENTHUSIA_GATEWAY_ALLOWED_SURFACES: 'discord,irc' })),
    ).toThrow();
    expect(() =>
      loadGatewayConfig(testEnv({ ENTHUSIA_GATEWAY_ALLOWED_SURFACES: '' })),
    ).toThrow();
    expect(() =>
      loadGatewayConfig(testEnv({ ENTHUSIA_GATEWAY_RATE_LIMIT_USER_PER_MIN: '0' })),
    ).toThrow();
    expect(() =>
      loadGatewayConfig(testEnv({ ENTHUSIA_GATEWAY_MAX_MESSAGE_BYTES: '-5' })),
    ).toThrow();
  });
});

describe('redactedGatewayConfig', () => {
  it('never includes API key values', () => {
    const config = loadGatewayConfig(
      testEnv({ ENTHUSIA_GATEWAY_API_KEYS: 'super-secret-key' }),
    );
    const redacted = redactedGatewayConfig(config);
    expect(redacted['apiKeysConfigured']).toBe(1);
    expect(redacted['authenticationEnabled']).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('super-secret-key');
  });
});
