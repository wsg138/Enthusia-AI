import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CostTracker } from './budget.js';
import { ConfigError, loadConfig, type GatewayConfig } from './config.js';
import {
  OpenAIClient,
  OpenAIParseError,
  type TokenUsage,
  type VisionImageContentType,
} from './openai-client.js';
import { estimateTokens } from './packet-format.js';

export const MAX_VISION_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_OBSERVATIONS = 20;
export const MAX_IMAGE_INFERENCES = 10;
export const MAX_IMAGE_LIMITATIONS = 10;
const MAX_VISION_OUTPUT_TOKENS = 1600;
const IMAGE_TOKEN_BUDGET_ALLOWANCE = 12_000;

const observationCategorySchema = z.enum([
  'visible_text',
  'gameplay',
  'game_ui',
  'object',
  'identity_marker',
  'other',
]);

const confidenceSchema = z.number().finite().min(0).max(1);
const boundedText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

const imageObservationSchema = z.strictObject({
  category: observationCategorySchema,
  text: boundedText(400),
  confidence: confidenceSchema,
});

const imageInferenceSchema = z.strictObject({
  text: boundedText(400),
  confidence: confidenceSchema,
  observationIndexes: z
    .array(z.number().int().nonnegative())
    .min(1)
    .max(MAX_IMAGE_OBSERVATIONS),
});

const imageEvidenceAssessmentSchema = z.strictObject({
  summary: boundedText(600),
  observations: z.array(imageObservationSchema).max(MAX_IMAGE_OBSERVATIONS),
  inferences: z.array(imageInferenceSchema).max(MAX_IMAGE_INFERENCES),
  limitations: z
    .array(boundedText(300))
    .max(MAX_IMAGE_LIMITATIONS),
  needsMoreContext: z.boolean(),
});

export type ImageObservationCategory = z.infer<
  typeof observationCategorySchema
>;
export type ImageObservation = z.infer<typeof imageObservationSchema>;
export type ImageInference = z.infer<typeof imageInferenceSchema>;
export type ImageEvidenceAssessment = z.infer<
  typeof imageEvidenceAssessmentSchema
>;

export interface RunImageEvidenceInput {
  traceId: string;
  evidenceRef: string;
  image: {
    bytes: Uint8Array;
    contentType: VisionImageContentType;
    sha256: string;
  };
  context?: {
    ticketCategory?: string;
    userQuestion?: string;
  };
}

export interface RunImageEvidenceResult {
  assessment: ImageEvidenceAssessment;
  evidenceRef: string;
  evidenceSha256: string;
  model: string;
  usage: TokenUsage;
  estimatedCostUsd: number;
}

export interface RunImageEvidenceDeps {
  config?: GatewayConfig;
  client?: OpenAIClient;
  tracker?: CostTracker;
}

export class ImageEvidenceDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageEvidenceDeniedError';
  }
}

export async function runImageEvidenceAssessment(
  input: RunImageEvidenceInput,
  deps: RunImageEvidenceDeps = {},
): Promise<RunImageEvidenceResult> {
  validateImageInput(input);
  const config = deps.config ?? loadConfig();
  const model = configuredVisionModel(config);
  const tracker =
    deps.tracker ?? new CostTracker(config.budget, config.modelPrices);

  requireExternalCallAllowance(input.traceId, config, tracker);
  const prompts = imageEvidencePrompts(input);
  const maxOutputTokens = Math.min(
    config.maxOutputTokens,
    MAX_VISION_OUTPUT_TOKENS,
  );
  tracker.checkBudget(
    input.traceId,
    model,
    estimatedVisionPromptTokens(prompts),
    maxOutputTokens,
  );

  const client = configuredClient(config, deps.client);
  const completion = await client.imageChatCompletion({
    model,
    systemPrompt: prompts.systemPrompt,
    userPrompt: prompts.userPrompt,
    image: {
      bytes: input.image.bytes,
      contentType: input.image.contentType,
      detail: 'high',
    },
    maxOutputTokens,
    temperature: 0,
  });
  const assessment = parseImageEvidenceAssessment(completion.content);
  const usage = tracker.recordUsage({
    traceId: input.traceId,
    packetRef: input.evidenceRef,
    model: completion.model,
    promptTokens: completion.usage.promptTokens,
    completionTokens: completion.usage.completionTokens,
  });

  return {
    assessment,
    evidenceRef: input.evidenceRef,
    evidenceSha256: input.image.sha256.toLowerCase(),
    model: completion.model,
    usage: completion.usage,
    estimatedCostUsd: usage.estimatedCostUsd,
  };
}

function configuredClient(
  config: GatewayConfig,
  injected: OpenAIClient | undefined,
): OpenAIClient {
  if (injected !== undefined) return injected;
  if (config.apiKey.trim().length === 0) {
    throw new ConfigError(
      'OPENAI_API_KEY is not set; refusing image assessment without credentials',
    );
  }
  return new OpenAIClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  });
}

function requireExternalCallAllowance(
  traceId: string,
  config: GatewayConfig,
  tracker: CostTracker,
): void {
  if (
    tracker.callsForRequest(traceId) <
    config.budget.maxEscalationsPerRequest
  ) {
    return;
  }
  throw new ImageEvidenceDeniedError(
    'OpenAI call limit reached for this request.',
  );
}

function configuredVisionModel(config: GatewayConfig): string {
  const model = config.visionModel?.trim();
  if (model) return model;
  throw new ConfigError(
    'ENTHUSIA_OPENAI_VISION_MODEL is not configured; image assessment is disabled',
  );
}

function validateImageInput(input: RunImageEvidenceInput): void {
  const size = input.image.bytes.byteLength;
  if (size < 1 || size > MAX_VISION_IMAGE_BYTES) {
    throw new ImageEvidenceDeniedError(
      'Image evidence is empty or exceeds the 8 MiB assessment limit.',
    );
  }

  const expected = input.image.sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new ImageEvidenceDeniedError(
      'Image evidence requires a valid SHA-256 provenance hash.',
    );
  }

  const actual = createHash('sha256').update(input.image.bytes).digest('hex');
  if (actual !== expected) {
    throw new ImageEvidenceDeniedError(
      'Image evidence bytes do not match their provenance hash.',
    );
  }
}

function imageEvidencePrompts(input: RunImageEvidenceInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  return {
    systemPrompt: [
      'You are the bounded image-evidence observer for Enthusia support tickets.',
      'Return JSON only, with exactly the requested fields.',
      'Separate directly observable visual facts from inference.',
      'Visible text may be transcribed, but uncertain text must receive lower confidence.',
      'Do not decide whether a server rule was violated.',
      'Do not recommend warnings, mutes, bans, or any punishment.',
      'Do not claim a real-world or account identity unless the exact label is visibly present.',
      'Do not invent context outside the image.',
      'When the image is cropped, blurry, ambiguous, or insufficient, say so in limitations and set needsMoreContext=true.',
    ].join('\n'),
    userPrompt: JSON.stringify({
      task: 'observe_ticket_image_evidence',
      evidence: {
        ref: input.evidenceRef,
        sha256: input.image.sha256.toLowerCase(),
        contentType: input.image.contentType,
      },
      context: {
        ticketCategory: input.context?.ticketCategory ?? null,
        userQuestion: optionalTruncatedText(input.context?.userQuestion, 500),
      },
      output: {
        summary: 'plain description, max 600 chars',
        observations: [
          {
            category:
              'visible_text|gameplay|game_ui|object|identity_marker|other',
            text: 'directly observable fact, max 400 chars',
            confidence: '0..1',
          },
        ],
        inferences: [
          {
            text: 'bounded inference, max 400 chars',
            confidence: '0..1',
            observationIndexes: [0],
          },
        ],
        limitations: ['max 300 chars each'],
        needsMoreContext: false,
      },
    }),
  };
}

function optionalTruncatedText(
  value: string | undefined,
  maximum: number,
): string | null {
  const normalized = value?.trim() ?? '';
  if (normalized.length === 0) return null;
  return normalized.length <= maximum
    ? normalized
    : normalized.slice(0, maximum);
}

function estimatedVisionPromptTokens(prompts: {
  systemPrompt: string;
  userPrompt: string;
}): number {
  return (
    estimateTokens(prompts.systemPrompt + '\n' + prompts.userPrompt) +
    IMAGE_TOKEN_BUDGET_ALLOWANCE
  );
}

export function parseImageEvidenceAssessment(
  text: string,
): ImageEvidenceAssessment {
  const candidate = stripSingleJsonFence(text);
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    throw new OpenAIParseError('image assessment is not valid JSON');
  }

  const parsed = imageEvidenceAssessmentSchema.safeParse(json);
  if (!parsed.success) {
    throw new OpenAIParseError('image assessment has an invalid JSON shape');
  }
  validateInferenceReferences(parsed.data);
  return parsed.data;
}

function validateInferenceReferences(
  assessment: ImageEvidenceAssessment,
): void {
  for (const inference of assessment.inferences) {
    if (
      inference.observationIndexes.some(
        (index) => index >= assessment.observations.length,
      )
    ) {
      throw new OpenAIParseError(
        'image inference references an invalid observation',
      );
    }
  }
}

function stripSingleJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = /^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i.exec(
    trimmed,
  );
  return match?.[1]?.trim() ?? trimmed;
}
