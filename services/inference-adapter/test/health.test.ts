import { describe, expect, it } from 'vitest';
import {
  checkInferenceHealth,
  InferenceClient,
  loadInferenceConfig,
  toReadinessDependency,
} from '../src/index.js';
import { startMockServer } from './mock-server.js';

function clientFor(url: string, env: Record<string, string> = {}): InferenceClient {
  return new InferenceClient({
    config: loadInferenceConfig({ ENTHUSIA_INFERENCE_BASE_URL: url, ...env }),
  });
}

describe('checkInferenceHealth', () => {
  it('reports ok with model name and version when a model is loaded', async () => {
    const server = await startMockServer({
      modelId: 'llama-test-model',
      modelMeta: { version: '2.0.0' },
    });
    try {
      const report = await checkInferenceHealth(clientFor(server.url));

      expect(report.status).toBe('ok');
      expect(report.modelLoaded).toBe(true);
      expect(report.modelName).toBe('llama-test-model');
      expect(report.modelVersion).toBe('2.0.0');
      expect(report.latencyMs).toBeGreaterThanOrEqual(0);
      expect(new Date(report.checkedAt).getTime()).not.toBeNaN();
      expect(server.stats.modelRequests).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('reports degraded when reachable but no model is loaded', async () => {
    const server = await startMockServer({ modelsEmpty: true });
    try {
      const report = await checkInferenceHealth(clientFor(server.url));

      expect(report.status).toBe('degraded');
      expect(report.modelLoaded).toBe(false);
      expect(report.modelName).toBeUndefined();
      expect(report.detail).toContain('no models');
    } finally {
      await server.close();
    }
  });

  it('reports down when the endpoint is unreachable', async () => {
    // Port 1 on loopback is (practically) never listening: connection refused.
    const report = await checkInferenceHealth(
      clientFor('http://127.0.0.1:1', {
        ENTHUSIA_INFERENCE_HEALTH_TIMEOUT_MS: '1000',
        ENTHUSIA_INFERENCE_MAX_RETRIES: '0',
      }),
    );

    expect(report.status).toBe('down');
    expect(report.modelLoaded).toBe(false);
    expect(report.detail).toBeDefined();
  });
});

describe('toReadinessDependency', () => {
  it('maps a healthy report into the shared readiness contract', async () => {
    const server = await startMockServer({
      modelId: 'llama-test-model',
      modelMeta: { version: '2.0.0' },
    });
    try {
      const report = await checkInferenceHealth(clientFor(server.url));
      const dependency = toReadinessDependency(report);

      expect(dependency.name).toBe('inference');
      expect(dependency.status).toBe('ok');
      expect(dependency.latencyMs).toBeGreaterThanOrEqual(0);
      expect(dependency.detail).toContain('llama-test-model');
      expect(dependency.detail).toContain('2.0.0');
    } finally {
      await server.close();
    }
  });
});
