import { describe, expect, it } from 'vitest';
import {
  loadGatewayConfig,
  redactedGatewayConfig,
} from '../src/config.js';

describe('gateway remote-agent configuration', () => {
  it('fails closed in production when the real agent link is absent', () => {
    expect(() =>
      loadGatewayConfig({
        NODE_ENV: 'production',
        ENTHUSIA_GATEWAY_API_KEYS: 'gateway-key',
      }),
    ).toThrow('ENTHUSIA_AGENT_BASE_URL');
  });

  it('requires a production agent service key as well as the URL', () => {
    expect(() =>
      loadGatewayConfig({
        NODE_ENV: 'production',
        ENTHUSIA_GATEWAY_API_KEYS: 'gateway-key',
        ENTHUSIA_AGENT_BASE_URL: 'http://agent.internal:4200',
      }),
    ).toThrow('ENTHUSIA_AGENT_API_KEY');
  });

  it('logs only redacted remote-agent configuration state', () => {
    const config = loadGatewayConfig({
      NODE_ENV: 'test',
      ENTHUSIA_AGENT_BASE_URL: 'http://agent.internal:4200',
      ENTHUSIA_AGENT_API_KEY: 'super-secret-agent-key',
    });
    const redacted = redactedGatewayConfig(config);
    expect(redacted).toMatchObject({
      remoteAgentConfigured: true,
      agentApiKeyConfigured: true,
    });
    expect(JSON.stringify(redacted)).not.toContain('super-secret-agent-key');
  });
});
