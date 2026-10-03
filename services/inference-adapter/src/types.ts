import { z } from 'zod';

/**
 * @enthusia/inference-adapter — public types and OpenAI-compatible wire schemas.
 *
 * Adapter boundary rule (W03): the ONLY HTTP routes this adapter may call are
 * OpenAI-compatible ones (`/v1/chat/completions`, `/v1/models`). No
 * llama.cpp-specific or vendor-specific routes are used anywhere, so the
 * runtime stays swappable per MASTER-SPECIFICATION.md §9.2.
 */

/** Chat message role in a generation request. */
export const chatRoles = ['system', 'user', 'assistant', 'tool'] as const;
export type ChatRole = (typeof chatRoles)[number];

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional tool-call correlation for `tool` role messages. */
  toolCallId?: string;
}

/** Per-request generation knobs. */
export interface GenerationOptions {
  /** Override the configured model for this request. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
}

export interface GenerationRequest extends GenerationOptions {
  messages: ChatMessage[];
}

const chatMessageSchema = z.object({
  role: z.enum(chatRoles),
  content: z.string(),
  toolCallId: z.string().optional(),
});

export const generationRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1, 'at least one message is required'),
  model: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  stop: z.array(z.string()).optional(),
});

/** GenerationRequest after Zod validation (optional fields widen to `T | undefined`). */
export type ParsedGenerationRequest = z.infer<typeof generationRequestSchema>;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GenerationResult {
  content: string;
  finishReason: string | null;
  usage: TokenUsage;
  /** Model identifier reported by the server. */
  model: string;
  /** End-to-end latency of the successful attempt (ms). */
  latencyMs: number;
  /** Total HTTP attempts used (1 + retries). */
  attempts: number;
  traceId?: string;
}

/** One streamed delta from an SSE completion. */
export interface StreamDelta {
  content: string;
  finishReason: string | null;
  model: string;
}

/**
 * Model capabilities descriptor.
 * Describes what the configured inference runtime can do so callers can
 * enforce token/context limits without knowing the runtime's internals.
 */
export interface ModelCapabilities {
  /** Model identifier (from /v1/models, config, or 'unknown'). */
  modelName: string;
  /** Context window in tokens used for limit enforcement. */
  contextLength: number;
  /** Maximum output tokens per request. */
  maxOutputTokens: number;
  /** Whether SSE streaming completions are supported. */
  supportsStreaming: boolean;
  /** Optional server-reported version string. */
  modelVersion?: string;
}

/** A model entry from GET /v1/models. */
export interface ModelInfo {
  id: string;
  created?: number;
  ownedBy?: string;
  /** Server-specific metadata; may carry a version string. */
  version?: string;
}

// --- Wire schemas (OpenAI-compatible) ---

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().optional(),
});

const chatCompletionMessageSchema = z
  .object({
    role: z.string(),
    content: z.string().nullable(),
  })
  .passthrough();

export const chatCompletionResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  choices: z
    .array(
      z.object({
        index: z.number().int().optional(),
        message: chatCompletionMessageSchema,
        finish_reason: z.string().nullable(),
      }),
    )
    .min(1),
  usage: usageSchema,
});

export type ChatCompletionResponse = z.infer<typeof chatCompletionResponseSchema>;

const streamDeltaSchema = z
  .object({
    role: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();

export const chatCompletionChunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().int().optional(),
        delta: streamDeltaSchema,
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: usageSchema.optional(),
});

export type ChatCompletionChunk = z.infer<typeof chatCompletionChunkSchema>;

const modelEntrySchema = z.object({
  id: z.string(),
  created: z.number().int().optional(),
  owned_by: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const modelsResponseSchema = z.object({
  object: z.string().optional(),
  data: z.array(modelEntrySchema),
});

/** Normalize a /v1/models entry to ModelInfo, extracting a version when present. */
export function toModelInfo(entry: z.infer<typeof modelEntrySchema>): ModelInfo {
  const meta = entry.meta;
  const version =
    meta !== undefined && typeof meta['version'] === 'string' ? meta['version'] : undefined;
  const info: ModelInfo = { id: entry.id };
  if (entry.created !== undefined) info.created = entry.created;
  if (entry.owned_by !== undefined) info.ownedBy = entry.owned_by;
  if (version !== undefined) info.version = version;
  return info;
}
