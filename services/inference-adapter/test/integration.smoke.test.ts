import { describe, expect, it } from 'vitest';
import { InferenceClient } from '../src/index.js';
import { loadInferenceConfig } from '../src/index.js';

/**
 * Real small-model smoke test (integration).
 *
 * Skipped unless ENTHUSIA_INFERENCE_SMOKE_URL points at a live
 * OpenAI-compatible endpoint (e.g. `llama-server` on localhost:8080 with a
 * small model loaded). Never downloads models; never runs in CI by default.
 */
const smokeUrl: string | undefined = process.env['ENTHUSIA_INFERENCE_SMOKE_URL'];

describe.skipIf(!smokeUrl)('inference smoke test (real local model)', () => {
  it(
    'lists models and completes a tiny generation',
    async () => {
      if (smokeUrl === undefined) {
        throw new Error('ENTHUSIA_INFERENCE_SMOKE_URL is required for the smoke test');
      }
      const client = new InferenceClient({
        config: loadInferenceConfig({
          ENTHUSIA_INFERENCE_BASE_URL: smokeUrl,
          ENTHUSIA_INFERENCE_TIMEOUT_MS: '60000',
          ENTHUSIA_INFERENCE_MAX_RETRIES: '1',
        }),
      });

      const models = await client.getModels();
      expect(models.length).toBeGreaterThan(0);
      const first = models[0];
      expect(first?.id).toBeTruthy();

      const result = await client.complete({
        messages: [{ role: 'user', content: 'Reply with exactly: smoke ok' }],
        maxTokens: 16,
      });
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.usage.completionTokens).toBeGreaterThan(0);
      expect(result.attempts).toBe(1);
    },
    90_000,
  );
});
