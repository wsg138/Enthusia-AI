import { describe, expect, it } from 'vitest';
import { ExternalServiceError, ToolTimeoutError, ValidationError } from '@enthusia/contracts';
import { InferenceClient } from '../src/client.js';
import { loadInferenceConfig } from '../src/config.js';
import { startMockServer } from './mock-server.js';

function clientFor(url: string, env: Record<string, string> = {}): InferenceClient {
  const config = loadInferenceConfig({ ENTHUSIA_INFERENCE_BASE_URL: url, ...env });
  return new InferenceClient({ config });
}

const helloRequest = { messages: [{ role: 'user' as const, content: 'Say hello' }] };

describe('InferenceClient — completions', () => {
  it('completes a non-streaming request and records metrics', async () => {
    const server = await startMockServer();
    try {
      const client = clientFor(server.url);
      const result = await client.complete(helloRequest);

      expect(result.content).toBe('Hello from mock');
      expect(result.finishReason).toBe('stop');
      expect(result.model).toBe('mock-model');
      expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 7, totalTokens: 19 });
      expect(result.attempts).toBe(1);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);

      const metrics = client.getMetrics();
      expect(metrics.totalRequests).toBe(1);
      expect(metrics.successfulRequests).toBe(1);
      expect(metrics.failedRequests).toBe(0);
      expect(metrics.promptTokens).toBe(12);
      expect(metrics.completionTokens).toBe(7);
      expect(metrics.latency.count).toBe(1);
      expect(metrics.activeRequests).toBe(0);
      expect(metrics.queueDepth).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('retries on 500 with backoff and succeeds', async () => {
    const server = await startMockServer({ failChatTimes: 2 });
    try {
      const client = clientFor(server.url, { ENTHUSIA_INFERENCE_RETRY_BASE_DELAY_MS: '10' });
      const result = await client.complete(helloRequest);

      expect(result.content).toBe('Hello from mock');
      expect(result.attempts).toBe(3);
      expect(server.stats.chatRequests).toBe(3);
      expect(client.getMetrics().retriedAttempts).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('gives up after max retries and throws ExternalServiceError', async () => {
    const server = await startMockServer({ failChatTimes: 10 });
    try {
      const client = clientFor(server.url, {
        ENTHUSIA_INFERENCE_MAX_RETRIES: '2',
        ENTHUSIA_INFERENCE_RETRY_BASE_DELAY_MS: '10',
      });
      const error = await client.complete(helloRequest).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ExternalServiceError);
      const typed = error as ExternalServiceError;
      expect(typed.code).toBe('EXTERNAL_SERVICE_ERROR');
      expect(typed.statusCode).toBe(502);
      expect(server.stats.chatRequests).toBe(3); // 1 initial + 2 retries
      const metrics = client.getMetrics();
      expect(metrics.failedRequests).toBe(1);
      expect(metrics.retriedAttempts).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('does not retry on 400', async () => {
    const server = await startMockServer({ chatStatus: 400 });
    try {
      const client = clientFor(server.url);
      await expect(client.complete(helloRequest)).rejects.toBeInstanceOf(ExternalServiceError);
      expect(server.stats.chatRequests).toBe(1);
      expect(client.getMetrics().retriedAttempts).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('enforces a bounded timeout on a hanging server', async () => {
    const server = await startMockServer({ chatHang: true });
    try {
      const client = clientFor(server.url, {
        ENTHUSIA_INFERENCE_TIMEOUT_MS: '300',
        ENTHUSIA_INFERENCE_MAX_RETRIES: '0',
      });
      const startedAt = Date.now();
      const error = await client.complete(helloRequest).catch((e: unknown) => e);
      const elapsed = Date.now() - startedAt;

      expect(error).toBeInstanceOf(ToolTimeoutError);
      const typed = error as ToolTimeoutError;
      expect(typed.code).toBe('TOOL_TIMEOUT');
      expect(typed.statusCode).toBe(504);
      // Bounded: must fail near the 300ms timeout, never hang indefinitely.
      expect(elapsed).toBeLessThan(5000);
      expect(server.stats.chatRequests).toBe(1);
      expect(client.getMetrics().failedRequests).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('streams SSE chunks in order and returns the assembled result', async () => {
    const server = await startMockServer({ streamChunks: ['Hel', 'lo', ' world'] });
    try {
      const client = clientFor(server.url);
      const deltas: string[] = [];
      const result = await client.completeStream(helloRequest, (delta) => {
        deltas.push(delta.content);
      });

      expect(deltas).toEqual(['Hel', 'lo', ' world']);
      expect(result.content).toBe('Hello world');
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 7, totalTokens: 19 });
      expect(server.stats.lastStreamFlag).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('parses CRLF-framed SSE streams', async () => {
    const server = await startMockServer({
      streamChunks: ['Hello', ' CRLF'],
      streamLineEnding: 'crlf',
    });
    try {
      const client = clientFor(server.url);
      const result = await client.completeStream(helloRequest, () => undefined);
      expect(result.content).toBe('Hello CRLF');
      expect(result.finishReason).toBe('stop');
    } finally {
      await server.close();
    }
  });

  it('times out when headers arrive but the streaming body stalls', async () => {
    const server = await startMockServer({ streamHangAfterHeaders: true });
    try {
      const client = clientFor(server.url, {
        ENTHUSIA_INFERENCE_TIMEOUT_MS: '300',
        ENTHUSIA_INFERENCE_MAX_RETRIES: '0',
      });
      const startedAt = Date.now();
      const error = await client
        .completeStream(helloRequest, () => undefined)
        .catch((e: unknown) => e);
      const elapsed = Date.now() - startedAt;

      expect(error).toBeInstanceOf(ToolTimeoutError);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await server.close();
    }
  });

  it('normalizes malformed successful responses to ValidationError', async () => {
    const server = await startMockServer({ invalidChatResponse: true });
    try {
      const client = clientFor(server.url);
      await expect(client.complete(helloRequest)).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await server.close();
    }
  });

  it('sends a Bearer token when an API key is configured', async () => {
    const server = await startMockServer();
    try {
      const client = clientFor(server.url, { ENTHUSIA_INFERENCE_API_KEY: 'test-key-123' });
      await client.complete(helloRequest);
      expect(server.stats.lastAuthHeader).toBe('Bearer test-key-123');
    } finally {
      await server.close();
    }
  });

  it('omits the auth header when no API key is configured', async () => {
    const server = await startMockServer();
    try {
      const client = clientFor(server.url);
      await client.complete(helloRequest);
      expect(server.stats.lastAuthHeader).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('sends the model from the request, the config, or omits it', async () => {
    const server = await startMockServer();
    try {
      const requestModel = clientFor(server.url);
      await requestModel.complete({ ...helloRequest, model: 'req-model' });
      expect((server.stats.lastRequestBody as { model?: string }).model).toBe('req-model');

      const configModel = clientFor(server.url, { ENTHUSIA_INFERENCE_MODEL: 'cfg-model' });
      await configModel.complete(helloRequest);
      expect((server.stats.lastRequestBody as { model?: string }).model).toBe('cfg-model');

      const noModel = clientFor(server.url);
      await noModel.complete(helloRequest);
      expect('model' in (server.stats.lastRequestBody as Record<string, unknown>)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('rejects an empty message list without calling the server', async () => {
    const server = await startMockServer();
    try {
      const client = clientFor(server.url);
      const error = await client.complete({ messages: [] }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe('VALIDATION_ERROR');
      expect(server.stats.chatRequests).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('exposes queue depth under concurrency pressure', async () => {
    const server = await startMockServer({ chatDelayMs: 400 });
    try {
      const client = clientFor(server.url, { ENTHUSIA_INFERENCE_CONCURRENCY: '1' });
      const first = client.complete(helloRequest);
      const second = client.complete(helloRequest);
      // Let the first acquire the single slot and the second start waiting.
      await new Promise((r) => setTimeout(r, 100));
      const during = client.getMetrics();
      expect(during.activeRequests).toBe(1);
      expect(during.queueDepth).toBe(1);

      const [r1, r2] = await Promise.all([first, second]);
      expect(r1.content).toBe('Hello from mock');
      expect(r2.content).toBe('Hello from mock');
      const after = client.getMetrics();
      expect(after.activeRequests).toBe(0);
      expect(after.queueDepth).toBe(0);
      expect(after.successfulRequests).toBe(2);
    } finally {
      await server.close();
    }
  });
});
