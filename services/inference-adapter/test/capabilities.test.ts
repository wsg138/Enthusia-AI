import { describe, expect, it } from 'vitest';
import { ValidationError } from '@enthusia/contracts';
import {
  buildCapabilities,
  enforceContextLimits,
  estimateTokens,
  loadInferenceConfig,
} from '../src/index.js';
import type { ModelCapabilities, ParsedGenerationRequest } from '../src/index.js';

function capabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    modelName: 'mock-model',
    contextLength: 100,
    maxOutputTokens: 20,
    supportsStreaming: true,
    ...overrides,
  };
}

function requestWith(content: string): ParsedGenerationRequest {
  return { messages: [{ role: 'user', content }] };
}

describe('estimateTokens', () => {
  it('estimates ~4 characters per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('buildCapabilities', () => {
  it('builds a descriptor from config alone', () => {
    const caps = buildCapabilities(loadInferenceConfig({}));
    expect(caps.modelName).toBe('unknown');
    expect(caps.contextLength).toBe(32_768);
    expect(caps.maxOutputTokens).toBe(4_096);
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.modelVersion).toBeUndefined();
  });

  it('prefers server model info when available', () => {
    const caps = buildCapabilities(loadInferenceConfig({}), {
      id: 'qwen-30b-instruct',
      version: '1.2.3',
    });
    expect(caps.modelName).toBe('qwen-30b-instruct');
    expect(caps.modelVersion).toBe('1.2.3');
  });

  it('falls back to the configured model name', () => {
    const caps = buildCapabilities(
      loadInferenceConfig({ ENTHUSIA_INFERENCE_MODEL: 'cfg-model' }),
    );
    expect(caps.modelName).toBe('cfg-model');
  });
});

describe('enforceContextLimits', () => {
  it('returns the estimated prompt tokens when within budget', () => {
    // 'hi' -> 1 token + 4 framing overhead = 5; budget is 80.
    const tokens = enforceContextLimits(requestWith('hi'), capabilities());
    expect(tokens).toBe(5);
  });

  it('throws ValidationError when the prompt exceeds the budget', () => {
    // 400 chars -> 100 tokens + 4 framing = 104 > 80 budget.
    const error = (() => {
      try {
        enforceContextLimits(requestWith('x'.repeat(400)), capabilities());
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe('VALIDATION_ERROR');
    expect((error as ValidationError).message).toContain('104');
  });

  it('honors a custom token estimator', () => {
    const tokens = enforceContextLimits(requestWith('x'.repeat(400)), capabilities(), {
      estimate: () => 1,
    });
    expect(tokens).toBe(5); // 1 estimated + 4 framing
  });
});
