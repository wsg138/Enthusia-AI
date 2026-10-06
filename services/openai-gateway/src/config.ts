/**
 * @enthusia/openai-gateway — gateway configuration (W13).
 *
 * The runtime OpenAI budget is separately configurable from the training
 * GPU $25 cap (WORKER-EXECUTION-PLAN.md §16). All values come from the
 * environment; real secrets are injected at deploy time only and are never
 * required to install, build, test, or run CI.
 */
import {
  DEFAULT_MODEL_PRICES,
  modelSelectionFromEnv,
  type EscalationKind,
  type ModelPrice,
} from './models.js';
import type { BudgetLimits } from './budget.js';

export interface GatewayConfig {
  /** Empty until a real key is injected; escalation refuses without one. */
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxOutputTokens: number;
  /** Explicit vision-capable model. Unset means image assessment is disabled. */
  visionModel?: string;
  modelSelection: Record<EscalationKind, string>;
  modelPrices: Record<string, ModelPrice>;
  budget: BudgetLimits;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_DAILY_BUDGET_USD = 10;
const DEFAULT_REQUEST_BUDGET_USD = 2;
const DEFAULT_MAX_ESCALATIONS_PER_REQUEST = 3;

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got '${raw}'`);
  }
  return parsed;
}

function parseNonNegativeNumber(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigError(`${name} must be a non-negative number, got '${raw}'`);
  }
  return parsed;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  const baseUrl = (env['OPENAI_BASE_URL'] ?? DEFAULT_BASE_URL).trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('not http(s)');
    }
  } catch {
    throw new ConfigError(
      `OPENAI_BASE_URL must be a valid http(s) URL, got '${baseUrl}'`,
    );
  }

  const visionModel = env['ENTHUSIA_OPENAI_VISION_MODEL']?.trim();

  return {
    apiKey: env['OPENAI_API_KEY'] ?? '',
    baseUrl,
    timeoutMs: parsePositiveInt(
      env['ENTHUSIA_OPENAI_TIMEOUT_MS'],
      DEFAULT_TIMEOUT_MS,
      'ENTHUSIA_OPENAI_TIMEOUT_MS',
    ),
    maxOutputTokens: parsePositiveInt(
      env['ENTHUSIA_OPENAI_MAX_OUTPUT_TOKENS'],
      DEFAULT_MAX_OUTPUT_TOKENS,
      'ENTHUSIA_OPENAI_MAX_OUTPUT_TOKENS',
    ),
    ...(visionModel ? { visionModel } : {}),
    modelSelection: modelSelectionFromEnv(env),
    modelPrices: DEFAULT_MODEL_PRICES,
    budget: {
      maxUsdPerRequest: parseNonNegativeNumber(
        env['ENTHUSIA_OPENAI_REQUEST_BUDGET_USD'],
        DEFAULT_REQUEST_BUDGET_USD,
        'ENTHUSIA_OPENAI_REQUEST_BUDGET_USD',
      ),
      maxUsdPerDay: parseNonNegativeNumber(
        env['ENTHUSIA_OPENAI_DAILY_BUDGET_USD'],
        DEFAULT_DAILY_BUDGET_USD,
        'ENTHUSIA_OPENAI_DAILY_BUDGET_USD',
      ),
      maxEscalationsPerRequest: parsePositiveInt(
        env['ENTHUSIA_OPENAI_MAX_ESCALATIONS_PER_REQUEST'],
        DEFAULT_MAX_ESCALATIONS_PER_REQUEST,
        'ENTHUSIA_OPENAI_MAX_ESCALATIONS_PER_REQUEST',
      ),
    },
  };
}
