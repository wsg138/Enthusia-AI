import { describe, expect, it } from 'vitest';
import { loadConfig, redactedConfig } from '../src/index.js';

describe('loadConfig', () => {
  it('applies sensible defaults with an empty environment', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(config.aiGatewayPort).toBe(4100);
    expect(config.inferenceConcurrency).toBe(2);
    expect(config.databaseUrl).toBeUndefined();
    expect(config.discordBotToken).toBeUndefined();
    expect(config.openaiApiKey).toBeUndefined();
  });

  it('reads values from the environment', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      ENTHUSIA_AI_GATEWAY_PORT: '8080',
      ENTHUSIA_LOG_LEVEL: 'debug',
    });
    expect(config.nodeEnv).toBe('production');
    expect(config.aiGatewayPort).toBe(8080);
    expect(config.logLevel).toBe('debug');
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ ENTHUSIA_AI_GATEWAY_PORT: 'not-a-port' })).toThrow();
    expect(() => loadConfig({ ENTHUSIA_LOG_LEVEL: 'verbose' })).toThrow();
  });
});

describe('redactedConfig', () => {
  it('never exposes secret values', () => {
    const config = loadConfig({
      ENTHUSIA_DATABASE_URL: 'postgres://user:SUPERSECRET@host/db',
      OPENAI_API_KEY: 'sk-very-secret',
    });
    const redacted = redactedConfig(config);
    expect(redacted['databaseUrl']).toBe('<set>');
    expect(redacted['openaiApiKey']).toBe('<set>');
    expect(redacted['discordBotToken']).toBe('<unset>');
    expect(JSON.stringify(redacted)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(redacted)).not.toContain('sk-very-secret');
  });

  it('keeps non-secret values readable', () => {
    const config = loadConfig({ ENTHUSIA_AI_GATEWAY_PORT: '9000' });
    expect(redactedConfig(config)['aiGatewayPort']).toBe(9000);
  });
});
