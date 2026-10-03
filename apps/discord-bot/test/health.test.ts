import { describe, expect, it } from 'vitest';

import { buildHealthReport } from '../src/health.js';
import { testOptions } from './mock-port.js';

describe('buildHealthReport', () => {
  it('reports an unprobed real gateway as degraded', () => {
    const report = buildHealthReport({
      options: testOptions({ useMockGateway: false }),
      botUserId: 'bot-1',
      version: 'test',
      uptimeSeconds: 5,
    });
    expect(report.status).toBe('degraded');
    expect(report.dependencies.find((dep) => dep.name === 'ai-gateway')?.status).toBe(
      'degraded',
    );
  });

  it('reports ready only after Discord and the real gateway are healthy', () => {
    const report = buildHealthReport({
      options: testOptions({ useMockGateway: false }),
      botUserId: 'bot-1',
      version: 'test',
      uptimeSeconds: 5,
      gatewayReachable: true,
    });
    expect(report.status).toBe('ok');
  });

  it('reports a failed gateway probe as degraded/down', () => {
    const report = buildHealthReport({
      options: testOptions({ useMockGateway: false }),
      botUserId: 'bot-1',
      version: 'test',
      uptimeSeconds: 5,
      gatewayReachable: false,
    });
    expect(report.status).toBe('degraded');
    expect(report.dependencies.find((dep) => dep.name === 'ai-gateway')?.status).toBe(
      'down',
    );
  });
});
