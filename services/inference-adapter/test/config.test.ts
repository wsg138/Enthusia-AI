import { describe, expect, it } from 'vitest';
import { loadInferenceConfig, redactedInferenceConfig } from '../src/index.js';

describe('loadInferenceConfig', () => {
  it('applies W03 defaults with an empty environment', () => {
    const config = loadInferenceConfig({});
    expect(config.inferenceBaseUrl).toBe('http://localhost:8080');
    expect(config.inferenceModel).toBe('');
    expect(config.inferenceApiKey).toBeUndefined();
    expect(config.inferenceTimeoutMs).toBe(120_000);
    expect(config.inferenceMaxRetries).toBe(3);
    expect(config.inferenceRetryBaseDelayMs).toBe(500);
    expect(config.inferenceRetryMaxDelayMs).toBe(10_000);
    expect(config.inferenceMaxContextTokens).toBe(32_768);
    expect(config.inferenceMaxOutputTokens).toBe(4_096);
    expect(config.inferenceHealthTimeoutMs).toBe(5_000);
  });

  it('reads inference values from the environment', () => {
    const config = loadInferenceConfig({
      ENTHUSIA_INFERENCE_BASE_URL: 'http://llm.internal:8080',
      ENTHUSIA_INFERENCE_MODEL: 'qwen-30b',
      ENTHUSIA_INFERENCE_TIMEOUT_MS: '45000',
      ENTHUSIA_INFERENCE_MAX_RETRIES: '5',
      ENTHUSIA_INFERENCE_MAX_CONTEXT_TOKENS: '16384',
    });
    expect(config.inferenceBaseUrl).toBe('http://llm.internal:8080');
    expect(config.inferenceModel).toBe('qwen-30b');
    expect(config.inferenceTimeoutMs).toBe(45_000);
    expect(config.inferenceMaxRetries).toBe(5);
    expect(config.inferenceMaxContextTokens).toBe(16_384);
  });

  it('requires an inference API key in production', () => {
    expect(() => loadInferenceConfig({ NODE_ENV: 'production' })).toThrow(
      /ENTHUSIA_INFERENCE_API_KEY/,
    );
    const config = loadInferenceConfig({
      NODE_ENV: 'production',
      ENTHUSIA_INFERENCE_API_KEY: 'production-inference-key',
    });
    expect(config.inferenceApiKey).toBe('production-inference-key');
  });

  it('rejects an invalid base URL', () => {
    expect(() => loadInferenceConfig({ ENTHUSIA_INFERENCE_BASE_URL: 'not-a-url' })).toThrow();
  });

  it('rejects non-positive timeouts and negative retries', () => {
    expect(() => loadInferenceConfig({ ENTHUSIA_INFERENCE_TIMEOUT_MS: '0' })).toThrow();
    expect(() => loadInferenceConfig({ ENTHUSIA_INFERENCE_TIMEOUT_MS: '-5' })).toThrow();
    expect(() => loadInferenceConfig({ ENTHUSIA_INFERENCE_MAX_RETRIES: '-1' })).toThrow();
  });
});

describe('redactedInferenceConfig', () => {
  it('never exposes the API key value', () => {
    const withKey = redactedInferenceConfig(
      loadInferenceConfig({ ENTHUSIA_INFERENCE_API_KEY: 'super-secret-key' }),
    );
    expect(withKey['inferenceApiKey']).toBe('<set>');
    expect(JSON.stringify(withKey)).not.toContain('super-secret-key');

    const withoutKey = redactedInferenceConfig(loadInferenceConfig({}));
    expect(withoutKey['inferenceApiKey']).toBe('<unset>');
  });

  it('keeps non-secret values visible', () => {
    const redacted = redactedInferenceConfig(
      loadInferenceConfig({ ENTHUSIA_INFERENCE_BASE_URL: 'http://llm.internal:8080' }),
    );
    expect(redacted['inferenceBaseUrl']).toBe('http://llm.internal:8080');
    expect(redacted['inferenceTimeoutMs']).toBe(120_000);
  });
});
