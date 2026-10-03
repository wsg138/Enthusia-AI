import { ValidationError } from '@enthusia/contracts';
import type { InferenceConfig } from './config.js';
import type { ModelCapabilities, ModelInfo, ParsedGenerationRequest } from './types.js';

/**
 * @enthusia/inference-adapter — model capabilities and token/context limits.
 *
 * Spec: MASTER-SPECIFICATION.md §10.4 (start ~16K–32K context; do not default
 * to the maximum advertised context) and §9.2 (configurable context).
 */

/**
 * Heuristic token estimator: ~4 characters per token for English text.
 *
 * This is an ESTIMATE used for pre-flight context-limit enforcement, not a
 * billing-grade count. Authoritative counts come from the server's `usage`
 * field after generation. Callers that need better estimates may inject
 * their own estimator into enforceContextLimits().
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type TokenEstimator = (text: string) => number;

/** Build the capabilities descriptor for the configured runtime. */
export function buildCapabilities(
  config: InferenceConfig,
  modelInfo?: ModelInfo,
): ModelCapabilities {
  const modelName =
    modelInfo?.id ?? (config.inferenceModel !== '' ? config.inferenceModel : 'unknown');
  const capabilities: ModelCapabilities = {
    modelName,
    contextLength: config.inferenceMaxContextTokens,
    maxOutputTokens: config.inferenceMaxOutputTokens,
    supportsStreaming: true,
  };
  if (modelInfo?.version !== undefined) {
    capabilities.modelVersion = modelInfo.version;
  }
  return capabilities;
}

/**
 * Enforce the context budget before sending a request.
 *
 * Estimates the prompt tokens across all messages plus a small per-message
 * framing overhead, reserves the configured max output tokens, and throws a
 * ValidationError (visibility-safe) when the request would exceed the
 * context window. Returns the estimated prompt token count.
 *
 * @param traceId optional correlation ID attached to the error.
 */
export function enforceContextLimits(
  request: ParsedGenerationRequest,
  capabilities: ModelCapabilities,
  options: { estimate?: TokenEstimator; traceId?: string | undefined } = {},
): number {
  const estimate = options.estimate ?? estimateTokens;
  // Per-message framing overhead (role tags, separators) — conservative 4 tokens.
  const framingOverhead = request.messages.length * 4;
  let promptTokens = framingOverhead;
  for (const message of request.messages) {
    promptTokens += estimate(message.content);
  }

  const budget = capabilities.contextLength - capabilities.maxOutputTokens;
  if (promptTokens > budget) {
    throw new ValidationError(
      `Prompt is too long: estimated ${promptTokens} tokens exceeds the ` +
        `context budget of ${budget} tokens ` +
        `(context window ${capabilities.contextLength} minus ` +
        `${capabilities.maxOutputTokens} reserved for output). ` +
        `Shorten the prompt or reduce context before retrying.`,
      options.traceId !== undefined ? { traceId: options.traceId } : {},
    );
  }
  return promptTokens;
}
