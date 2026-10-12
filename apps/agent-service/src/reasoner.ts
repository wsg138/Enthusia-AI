import { z } from 'zod';
import type {
  EvidencePlanStep,
  IntentClassification,
  InvestigationDecision,
  InvestigationSnapshot,
  Reasoner,
  ResponseDraft,
  ToolMetadata,
} from '@enthusia/agent-core';
import type {
  GenerationRequest,
  InferenceClient,
  RequestOptions,
} from '@enthusia/inference-adapter';
import type { ChatRequest } from '@enthusia/contracts';

type CompletionClient = Pick<InferenceClient, 'complete'>;

const classificationSchema = z.strictObject({
  requestClass: z.enum(['simple', 'investigative', 'engineering']),
  summary: z.string().min(1).max(500),
  claims: z.array(z.string().min(1).max(500)).max(24),
  backgroundClaims: z.array(z.string().min(1).max(500)).max(12).optional(),
  needsFamiliarityContext: z.boolean().optional(),
  // Small local models sometimes emit an empty string for an unused optional
  // field. Treat only the blank placeholder as absent, never as a topic.
  familiarityTopic: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().min(1).max(160).optional(),
  ),
  needsPrivateContext: z.boolean(),
  securitySensitive: z.boolean(),
});

const planStepSchema = z.strictObject({
  claim: z.string().min(1).max(500),
  candidateTools: z.array(z.string().min(1)).max(16),
  verificationTier: z.enum(['A', 'B', 'C']),
  privacySensitive: z.boolean(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const toolCallSchema = z.strictObject({
  toolName: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  claim: z.string().min(1).optional(),
  rationale: z.string().max(500).optional(),
});

const claimHintSchema = z.strictObject({
  claim: z.string().min(1),
  verdict: z.enum(['supported', 'unsupported', 'contradicted']),
  note: z.string().max(500).optional(),
});

const memoryProposalSchema = z.strictObject({
  namespace: z.string().min(1),
  key: z.string().min(1),
  scope: z.string().min(1),
  summary: z.string().min(1),
  value: z.unknown(),
});

const escalationHintSchema = z.strictObject({
  target: z.enum(['openai', 'staff', 'owner']),
  reason: z.string().min(1).max(1000),
});

const decisionSchema = z.strictObject({
  action: z.enum(['call_tools', 'finish']),
  calls: z.array(toolCallSchema).max(16),
  claimHints: z.array(claimHintSchema).max(24).optional(),
  memoryProposals: z.array(memoryProposalSchema).max(12).optional(),
  escalationHint: escalationHintSchema.optional(),
  note: z.string().max(1000).optional(),
});

function stripSingleFence(text: string): string {
  const trimmed = text.trim();
  const match = /^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i.exec(trimmed);
  if (match === null || match[1] === undefined) return trimmed;
  return match[1].trim();
}

function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  const candidate = stripSingleFence(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error('local reasoner returned non-JSON output');
  }
  const direct = schema.safeParse(parsed);
  if (direct.success) return direct.data;
  // Some Qwen3 completions mirror the example's `output` property and put
  // the actual JSON inside it. Accept only a single-key wrapper and validate
  // the inner value against the SAME strict schema. Unknown extra keys still
  // fail; there is no permissive extraction of model-proposed controls.
  if (
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) &&
    Object.keys(parsed).length === 1 &&
    Object.prototype.hasOwnProperty.call(parsed, 'output')
  ) {
    const wrapped = schema.safeParse((parsed as Record<string, unknown>)['output']);
    if (wrapped.success) return wrapped.data;
  }
  throw new Error('local reasoner returned invalid JSON shape');
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function escapeJsonCharacter(value: string): string {
  const known = JSON_ESCAPES[value];
  if (known !== undefined) return known;
  const code = value.charCodeAt(0);
  return code < 32
    ? '\\u' + code.toString(16).padStart(4, '0')
    : value;
}

function quoteJson(value: string): string {
  return '"' + Array.from(value, escapeJsonCharacter).join('') + '"';
}

function stableObjectJson(value: Record<string, unknown>): string {
  const fields = Object.keys(value)
    .sort()
    .map((key) => quoteJson(key) + ':' + stableJson(value[key]));
  return '{' + fields.join(',') + '}';
}

function scalarJson(value: unknown): string | undefined {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return quoteJson(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'number') return undefined;
  return Number.isFinite(value) ? String(value) : 'null';
}

function stableJson(value: unknown): string {
  const scalar = scalarJson(value);
  if (scalar !== undefined) return scalar;
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableJson(item)).join(',') + ']';
  }
  if (typeof value === 'object' && value !== null) {
    return stableObjectJson(value as Record<string, unknown>);
  }
  return 'null';
}

function systemInstruction(task: string): string {
  return [
    'You are the local planning model inside Enthusia AI.',
    'Return JSON only. Do not use Markdown or code fences.',
    'Never invent a tool name, parameter, server fact, command, permission, or player fact.',
    'Current Enthusia-specific facts require tool/source evidence; model memory is not evidence.',
    'Do not reveal hidden reasoning. Keep notes short and operational.',
    task,
  ].join('\n');
}

function toolSummary(tools: ToolMetadata[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    verificationTier: tool.verificationTier ?? null,
    privacySensitive: tool.privacySensitive,
    maxVisibility: tool.maxVisibility,
  }));
}

function normalizePlanSteps(
  raw: Array<z.infer<typeof planStepSchema>>,
): EvidencePlanStep[] {
  return raw.map((step) => ({
    claim: step.claim,
    candidateTools: [...step.candidateTools],
    verificationTier: step.verificationTier,
    privacySensitive: step.privacySensitive,
    ...(step.params !== undefined ? { params: step.params } : {}),
  }));
}

function normalizeDecision(
  raw: z.infer<typeof decisionSchema>,
): InvestigationDecision {
  const calls = raw.calls.map((call) => ({
    toolName: call.toolName,
    params: call.params,
    ...(call.claim !== undefined ? { claim: call.claim } : {}),
    ...(call.rationale !== undefined ? { rationale: call.rationale } : {}),
  }));
  const decision: InvestigationDecision = {
    action: raw.action,
    calls,
  };
  if (raw.claimHints !== undefined) {
    decision.claimHints = raw.claimHints.map((hint) => ({
      claim: hint.claim,
      verdict: hint.verdict,
      ...(hint.note !== undefined ? { note: hint.note } : {}),
    }));
  }
  if (raw.memoryProposals !== undefined) {
    decision.memoryProposals = raw.memoryProposals.map((proposal) => ({
      namespace: proposal.namespace,
      key: proposal.key,
      scope: proposal.scope,
      summary: proposal.summary,
      value: proposal.value,
    }));
  }
  if (raw.escalationHint !== undefined) {
    decision.escalationHint = {
      target: raw.escalationHint.target,
      reason: raw.escalationHint.reason,
    };
  }
  if (raw.note !== undefined) decision.note = raw.note;
  return decision;
}

export class InferenceReasoner implements Reasoner {
  constructor(private readonly client: CompletionClient) {}

  async classifyIntent(request: ChatRequest): Promise<IntentClassification> {
    const raw = await this.completeJson(
      {
        messages: [
          {
            role: 'system',
            content: systemInstruction(
              'Classify the request. claims must contain only factual propositions that the final answer would need to verify. Purely conversational requests may have an empty claims array. backgroundClaims, when present, must be a subset of claims containing only short introductory facts that can be omitted for a player already familiar with the topic. Set needsFamiliarityContext=true only for player-facing help about a server-specific concept where explanation depth would materially improve the answer, and provide a short familiarityTopic. Set needsPrivateContext=true only when factual answering genuinely requires identity-scoped, ticket-private, staff-only, or internal live-server evidence; familiarity style lookup alone does not require needsPrivateContext=true.',
            ),
          },
          {
            role: 'user',
            content: stableJson({
              task: 'classify_intent',
              request: {
                surface: request.surface,
                actorType: request.actor.type,
                message: request.message,
                context: request.context ?? {},
              },
              output: {
                requestClass: 'simple|investigative|engineering',
                summary: 'short string',
                claims: ['claim to verify'],
                backgroundClaims: ['optional introductory claim from claims'],
                needsFamiliarityContext: false,
                familiarityTopic: 'optional server concept',
                needsPrivateContext: false,
                securitySensitive: false,
              },
            }),
          },
        ],
        maxTokens: 900,
        temperature: 0,
      },
      classificationSchema,
      request.traceId,
      'classifyIntent',
    );

    return {
      requestClass: raw.requestClass,
      summary: raw.summary,
      claims: [...raw.claims],
      ...(raw.backgroundClaims !== undefined
        ? { backgroundClaims: [...raw.backgroundClaims] }
        : {}),
      ...(raw.needsFamiliarityContext !== undefined
        ? { needsFamiliarityContext: raw.needsFamiliarityContext }
        : {}),
      ...(raw.familiarityTopic !== undefined
        ? { familiarityTopic: raw.familiarityTopic }
        : {}),
      needsPrivateContext: raw.needsPrivateContext,
      securitySensitive: raw.securitySensitive,
    };
  }

  async planEvidence(
    request: ChatRequest,
    classification: IntentClassification,
    availableTools: ToolMetadata[],
  ): Promise<EvidencePlanStep[]> {
    // No registered sources means no verifiable evidence plan is possible.
    // Avoid asking smaller models to invent tools or return prose instead
    // of a plan. Normal strict model validation still applies when tools exist.
    if (availableTools.length === 0) return [];
    const raw = await this.completeJson(
      {
        messages: [
          {
            role: 'system',
            content: systemInstruction(
              'Build an evidence plan. Use only tool names supplied in availableTools. Every step must serve a claim. Prefer live tier A evidence for mutable facts, then verified tier B source, then current tier C memory.',
            ),
          },
          {
            role: 'user',
            content: stableJson({
              task: 'plan_evidence',
              request: {
                surface: request.surface,
                actorType: request.actor.type,
                message: request.message,
              },
              classification,
              availableTools: toolSummary(availableTools),
            }),
          },
        ],
        maxTokens: 1800,
        temperature: 0,
      },
      z.array(planStepSchema).max(32),
      request.traceId,
      'planEvidence',
    );
    return normalizePlanSteps(raw);
  }

  async nextStep(
    snapshot: InvestigationSnapshot,
  ): Promise<InvestigationDecision> {
    const raw = await this.completeJson(
      {
        messages: [
          {
            role: 'system',
            content: systemInstruction(
              'Choose the next bounded investigation step. Use only candidate tool names already present in the plan. If sufficient current evidence exists or no useful call remains, return action=finish with an empty calls array.',
            ),
          },
          {
            role: 'user',
            content: stableJson({
              task: 'next_investigation_step',
              snapshot,
            }),
          },
        ],
        maxTokens: 1800,
        temperature: 0,
      },
      decisionSchema,
      snapshot.request.traceId,
      'nextStep',
    );
    return normalizeDecision(raw);
  }

  async draftResponse(): Promise<ResponseDraft> {
    return {};
  }

  private async completeJson<T>(
    request: GenerationRequest,
    schema: z.ZodType<T>,
    traceId?: string,
    stage = 'unknown',
  ): Promise<T> {
    const options: RequestOptions = {};
    if (traceId !== undefined) options.traceId = traceId;
    const result = await this.client.complete(request, options);
    try {
      return parseJson(result.content, schema);
    } catch (error) {
      // Stage-only failure detail is safe for internal diagnostics; never log
      // prompts, completions or user-provided model text to Discord.
      throw new Error(`${stage}: ${error instanceof Error ? error.message : 'invalid local model response'}`);
    }
  }
}
