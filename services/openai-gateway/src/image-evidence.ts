import { createHash } from 'node:crypto';
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

export type ImageObservationCategory =
  | 'visible_text'
  | 'gameplay'
  | 'game_ui'
  | 'object'
  | 'identity_marker'
  | 'other';

export interface ImageObservation {
  category: ImageObservationCategory;
  text: string;
  confidence: number;
}

export interface ImageInference {
  text: string;
  confidence: number;
  observationIndexes: number[];
}

export interface ImageEvidenceAssessment {
  summary: string;
  observations: ImageObservation[];
  inferences: ImageInference[];
  limitations: string[];
  needsMoreContext: boolean;
}

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
  requireExternalCallAllowance(input.traceId, config, deps.tracker);

  const tracker =
    deps.tracker ?? new CostTracker(config.budget, config.modelPrices);
  const prompts = imageEvidencePrompts(input);
  const maxOutputTokens = Math.min(
    config.maxOutputTokens,
    MAX_VISION_OUTPUT_TOKENS,
  );
  const estimatedPromptTokens =
    estimateTokens(prompts.systemPrompt + '\n' + prompts.userPrompt) +
    IMAGE_TOKEN_BUDGET_ALLOWANCE;
  tracker.checkBudget(
    input.traceId,
    model,
    estimatedPromptTokens,
    maxOutputTokens,
  );

  if (config.apiKey.trim().length === 0 && deps.client === undefined) {
    throw new ConfigError(
      'OPENAI_API_KEY is not set; refusing image assessment without credentials',
    );
  }
  const client =
    deps.client ??
    new OpenAIClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    });

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

function requireExternalCallAllowance(
  traceId: string,
  config: GatewayConfig,
  tracker: CostTracker | undefined,
): void {
  if (tracker === undefined) return;
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
  const systemPrompt = [
    'You are the bounded image-evidence observer for Enthusia support tickets.',
    'Return JSON only, with exactly the requested fields.',
    'Separate directly observable visual facts from inference.',
    'Visible text may be transcribed, but uncertain text must receive lower confidence.',
    'Do not decide whether a server rule was violated.',
    'Do not recommend warnings, mutes, bans, or any punishment.',
    'Do not claim a real-world or account identity unless the exact label is visibly present.',
    'Do not invent context outside the image.',
    'When the image is cropped, blurry, ambiguous, or insufficient, say so in limitations and set needsMoreContext=true.',
  ].join('\n');

  const userPrompt = JSON.stringify({
    task: 'observe_ticket_image_evidence',
    evidence: {
      ref: input.evidenceRef,
      sha256: input.image.sha256.toLowerCase(),
      contentType: input.image.contentType,
    },
    context: {
      ticketCategory: input.context?.ticketCategory ?? null,
      userQuestion: truncate(input.context?.userQuestion ?? '', 500) || null,
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
  });

  return { systemPrompt, userPrompt };
}

export function parseImageEvidenceAssessment(
  text: string,
): ImageEvidenceAssessment {
  const parsed = parseJsonObject(stripFence(text));
  const summary = boundedString(parsed['summary'], 600, 'summary');
  const observations = parseObservations(parsed['observations']);
  const inferences = parseInferences(parsed['inferences'], observations.length);
  const limitations = parseStringList(
    parsed['limitations'],
    MAX_IMAGE_LIMITATIONS,
    300,
    'limitations',
  );
  if (typeof parsed['needsMoreContext'] !== 'boolean') {
    throw new OpenAIParseError('image assessment needsMoreContext must be boolean');
  }
  requireExactKeys(parsed, [
    'summary',
    'observations',
    'inferences',
    'limitations',
    'needsMoreContext',
  ]);
  return {
    summary,
    observations,
    inferences,
    limitations,
    needsMoreContext: parsed['needsMoreContext'],
  };
}

function parseObservations(value: unknown): ImageObservation[] {
  if (!Array.isArray(value) || value.length > MAX_IMAGE_OBSERVATIONS) {
    throw new OpenAIParseError('image assessment observations are invalid');
  }
  return value.map((item) => {
    const record = parseJsonRecord(item, 'observation');
    requireExactKeys(record, ['category', 'text', 'confidence']);
    const category = record['category'];
    if (!isObservationCategory(category)) {
      throw new OpenAIParseError('image observation category is invalid');
    }
    return {
      category,
      text: boundedString(record['text'], 400, 'observation text'),
      confidence: confidence(record['confidence'], 'observation confidence'),
    };
  });
}

function parseInferences(
  value: unknown,
  observationCount: number,
): ImageInference[] {
  if (!Array.isArray(value) || value.length > MAX_IMAGE_INFERENCES) {
    throw new OpenAIParseError('image assessment inferences are invalid');
  }
  return value.map((item) => {
    const record = parseJsonRecord(item, 'inference');
    requireExactKeys(record, ['text', 'confidence', 'observationIndexes']);
    return {
      text: boundedString(record['text'], 400, 'inference text'),
      confidence: confidence(record['confidence'], 'inference confidence'),
      observationIndexes: observationIndexes(
        record['observationIndexes'],
        observationCount,
      ),
    };
  });
}

function observationIndexes(
  value: unknown,
  observationCount: number,
): number[] {
  if (!Array.isArray(value) || value.length > MAX_IMAGE_OBSERVATIONS) {
    throw new OpenAIParseError('image inference observation indexes are invalid');
  }
  const indexes = [...new Set(value)];
  if (
    !indexes.every(
      (index) =>
        typeof index === 'number' &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < observationCount,
    )
  ) {
    throw new OpenAIParseError('image inference references an invalid observation');
  }
  return indexes as number[];
}

function parseStringList(
  value: unknown,
  maximumItems: number,
  maximumChars: number,
  label: string,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new OpenAIParseError(`image assessment ${label} are invalid`);
  }
  return value.map((item) => boundedString(item, maximumChars, label));
}

function confidence(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new OpenAIParseError(`${label} must be between 0 and 1`);
  }
  return value;
}

function boundedString(
  value: unknown,
  maximumChars: number,
  label: string,
): string {
  if (typeof value !== 'string') {
    throw new OpenAIParseError(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximumChars) {
    throw new OpenAIParseError(`${label} exceeds its bounds`);
  }
  return normalized;
}

function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OpenAIParseError('image assessment is not valid JSON');
  }
  return parseJsonRecord(value, 'assessment');
}

function parseJsonRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenAIParseError(`image ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).every((key) => allowedSet.has(key))) return;
  throw new OpenAIParseError('image assessment contains unexpected fields');
}

function isObservationCategory(
  value: unknown,
): value is ImageObservationCategory {
  return (
    value === 'visible_text' ||
    value === 'gameplay' ||
    value === 'game_ui' ||
    value === 'object' ||
    value === 'identity_marker' ||
    value === 'other'
  );
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(
    trimmed,
  );
  return match?.[1]?.trim() ?? trimmed;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}
