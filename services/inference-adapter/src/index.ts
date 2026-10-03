/**
 * @enthusia/inference-adapter — swappable local inference adapter (W03).
 *
 * Spec: MASTER-SPECIFICATION.md §§9.2, 10, 36; WORKER-EXECUTION-PLAN.md §6.
 *
 * This package is the ONLY place that talks HTTP to the inference runtime,
 * and it only speaks OpenAI-compatible routes (/v1/chat/completions,
 * /v1/models). Swap llama.cpp for vLLM or any other OpenAI-compatible server
 * by changing ENTHUSIA_INFERENCE_BASE_URL — no application code changes.
 */

// Configuration
export {
  inferenceConfigSchema,
  loadInferenceConfig,
  redactedInferenceConfig,
  type InferenceConfig,
} from './config.js';

// Capabilities and token/context limits
export {
  buildCapabilities,
  enforceContextLimits,
  estimateTokens,
  type TokenEstimator,
} from './capabilities.js';

// Metrics
export {
  InferenceMetrics,
  emptyMetricsSnapshot,
  type LatencyStats,
  type MetricsSnapshot,
} from './metrics.js';

// Client
export { InferenceClient, type InferenceClientOptions, type RequestOptions } from './client.js';

// Health
export {
  checkInferenceHealth,
  toReadinessDependency,
  type InferenceHealthReport,
} from './health.js';

// Types
export {
  chatCompletionChunkSchema,
  chatCompletionResponseSchema,
  chatRoles,
  generationRequestSchema,
  modelsResponseSchema,
  toModelInfo,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatMessage,
  type ChatRole,
  type GenerationOptions,
  type GenerationRequest,
  type ParsedGenerationRequest,
  type GenerationResult,
  type ModelCapabilities,
  type ModelInfo,
  type StreamDelta,
  type TokenUsage,
} from './types.js';
