/**
 * @enthusia/openai-gateway — explicit model selection policy (W13).
 *
 * Spec: MASTER-SPECIFICATION.md §37 (explicit model selection policy), §22
 * (OpenAI escalation). Model names are configuration, not code: the defaults
 * below are operator-overridable via ENTHUSIA_OPENAI_MODEL_<KIND> and the
 * per-model price table is an estimate the operator must keep current.
 */

/** Escalation categories, derived from the §22.1 triggers. */
export type EscalationKind =
  | 'coding'
  | 'debugging'
  | 'investigation'
  | 'architecture'
  | 'analysis';

export const ESCALATION_KINDS: readonly EscalationKind[] = [
  'coding',
  'debugging',
  'investigation',
  'architecture',
  'analysis',
] as const;

export function isEscalationKind(value: unknown): value is EscalationKind {
  return (
    typeof value === 'string' &&
    (ESCALATION_KINDS as readonly string[]).includes(value)
  );
}

/** USD price per 1M tokens. Estimates only — verify against current pricing. */
export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

/**
 * Default model per escalation kind.
 *
 * Defaults only — the operator sets these per available models
 * (see README and ENTHUSIA_OPENAI_MODEL_<KIND>). Never hard-code model
 * names in callers; always go through this map.
 */
export const DEFAULT_MODEL_SELECTION: Record<EscalationKind, string> = {
  coding: 'gpt-5.2-codex',
  debugging: 'gpt-5.2',
  investigation: 'gpt-5.2',
  architecture: 'gpt-5.2',
  analysis: 'gpt-5.2-mini',
};

/** Estimated per-model prices (USD per 1M tokens). Operator-maintained. */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-5.2': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  'gpt-5.2-codex': { inputPerMillionUsd: 3, outputPerMillionUsd: 12 },
  'gpt-5.2-mini': { inputPerMillionUsd: 0.5, outputPerMillionUsd: 2 },
};

/** Conservative fallback price for models missing from the price table. */
export const FALLBACK_MODEL_PRICE: ModelPrice = {
  inputPerMillionUsd: 5,
  outputPerMillionUsd: 20,
};

export function priceForModel(
  model: string,
  prices: Record<string, ModelPrice>,
): ModelPrice {
  return prices[model] ?? FALLBACK_MODEL_PRICE;
}

export function resolveModelSelection(
  overrides: Partial<Record<EscalationKind, string>> = {},
): Record<EscalationKind, string> {
  return { ...DEFAULT_MODEL_SELECTION, ...overrides };
}

/**
 * Build the model map with per-kind env overrides:
 * ENTHUSIA_OPENAI_MODEL_CODING, ENTHUSIA_OPENAI_MODEL_DEBUGGING, ...
 */
export function modelSelectionFromEnv(
  env: Record<string, string | undefined> = process.env,
): Record<EscalationKind, string> {
  const overrides: Partial<Record<EscalationKind, string>> = {};
  for (const kind of ESCALATION_KINDS) {
    const value = env[`ENTHUSIA_OPENAI_MODEL_${kind.toUpperCase()}`];
    if (value !== undefined && value.trim().length > 0) {
      overrides[kind] = value.trim();
    }
  }
  return resolveModelSelection(overrides);
}
