import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import {
  DEFAULT_MODEL_SELECTION,
  modelSelectionFromEnv,
} from '../src/models.js';

describe('loadConfig', () => {
  it('loads sane defaults with no env', () => {
    const config = loadConfig({});
    expect(config.apiKey).toBe('');
    expect(config.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.timeoutMs).toBe(120_000);
    expect(config.budget.maxUsdPerRequest).toBe(2);
    expect(config.budget.maxUsdPerDay).toBe(10);
    expect(config.budget.maxEscalationsPerRequest).toBe(3);
    expect(config.modelSelection).toEqual(DEFAULT_MODEL_SELECTION);
    expect(config.visionModel).toBeUndefined();
  });

  it('applies env overrides for budgets, timeout, and base URL', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-openai-key-not-real',
      OPENAI_BASE_URL: 'http://127.0.0.1:9999/v1/',
      ENTHUSIA_OPENAI_TIMEOUT_MS: '30000',
      ENTHUSIA_OPENAI_REQUEST_BUDGET_USD: '5.5',
      ENTHUSIA_OPENAI_DAILY_BUDGET_USD: '50',
      ENTHUSIA_OPENAI_MAX_ESCALATIONS_PER_REQUEST: '7',
      ENTHUSIA_OPENAI_VISION_MODEL: 'vision-test-model',
    });
    expect(config.apiKey).toBe('test-openai-key-not-real');
    expect(config.baseUrl).toBe('http://127.0.0.1:9999/v1/');
    expect(config.timeoutMs).toBe(30_000);
    expect(config.budget.maxUsdPerRequest).toBe(5.5);
    expect(config.budget.maxUsdPerDay).toBe(50);
    expect(config.budget.maxEscalationsPerRequest).toBe(7);
    expect(config.visionModel).toBe('vision-test-model');
  });

  it('rejects invalid values with ConfigError', () => {
    expect(() =>
      loadConfig({ ENTHUSIA_OPENAI_TIMEOUT_MS: '0' }),
    ).toThrowError(ConfigError);
    expect(() =>
      loadConfig({ ENTHUSIA_OPENAI_DAILY_BUDGET_USD: '-1' }),
    ).toThrowError(ConfigError);
    expect(() => loadConfig({ OPENAI_BASE_URL: 'notaurl' })).toThrowError(
      ConfigError,
    );
    expect(() =>
      loadConfig({ OPENAI_BASE_URL: 'ftp://example.com' }),
    ).toThrowError(ConfigError);
  });
});

describe('modelSelectionFromEnv', () => {
  it('overrides per-kind models from env', () => {
    const selection = modelSelectionFromEnv({
      ENTHUSIA_OPENAI_MODEL_CODING: 'custom-coding-model',
    });
    expect(selection.coding).toBe('custom-coding-model');
    expect(selection.debugging).toBe(DEFAULT_MODEL_SELECTION.debugging);
  });

  it('ignores blank overrides', () => {
    const selection = modelSelectionFromEnv({
      ENTHUSIA_OPENAI_MODEL_CODING: '   ',
    });
    expect(selection.coding).toBe(DEFAULT_MODEL_SELECTION.coding);
  });
});
