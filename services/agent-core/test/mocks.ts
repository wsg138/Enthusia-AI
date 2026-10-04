/**
 * @enthusia/agent-core — test mocks (W12).
 *
 * Mock tools and a scripted mock reasoner. NO real inference calls, NO
 * production data — every scenario is fully deterministic.
 */
import { newTraceId, SourceStatus, Visibility } from '@enthusia/contracts';
import type {
  Actor,
  ChatRequest,
  ToolResult,
} from '@enthusia/contracts';
import { encodeFreshness } from '../src/freshness.js';
import type { Reasoner } from '../src/reasoner.js';
import type { InvestigationDecision } from '../src/reasoner.js';
import type {
  IntentClassification,
  EvidencePlanStep,
  InvestigationSnapshot,
  ResponseDraft,
} from '../src/types.js';
import type { DraftArgs } from '../src/reasoner.js';
import {
  ToolRegistry,
  type Tool,
  type ToolCallContext,
  type ToolMetadata,
} from '../src/tool.js';

// ---------------------------------------------------------------------------
// Tool result builders
// ---------------------------------------------------------------------------

export interface MockFreshness {
  version?: string;
  observedTime?: string;
  sourceStatus?: SourceStatus;
}

/** Build a successful ToolResult with structured freshness. */
export function okResult(
  toolName: string,
  source: string,
  result: unknown,
  opts: {
    visibility?: Visibility;
    freshness?: MockFreshness;
    /** Raw freshness string override (for malformed/missing-freshness tests). */
    freshnessRaw?: string | null;
    correlationId?: string;
    timestamp?: string;
  } = {},
): ToolResult<unknown> {
  const freshness = opts.freshness ?? {
    version: 'v-test-1',
    observedTime: new Date().toISOString(),
    sourceStatus: SourceStatus.CURRENT,
  };
  const out: ToolResult<unknown> = {
    toolName,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    source,
    visibility: opts.visibility ?? Visibility.PUBLIC,
    correlationId: opts.correlationId ?? 'corr-test',
    result,
  };
  if (opts.freshnessRaw !== undefined) {
    if (opts.freshnessRaw !== null) {
      out.freshness = opts.freshnessRaw;
    }
  } else {
    out.freshness = encodeFreshness({
      version: freshness.version ?? 'v-test-1',
      observedTime: freshness.observedTime ?? new Date().toISOString(),
      sourceStatus: freshness.sourceStatus ?? SourceStatus.CURRENT,
    });
  }
  return out;
}

/** Build a failed ToolResult. */
export function errResult(
  toolName: string,
  source: string,
  code = 'tool_error',
  message = 'mock failure',
): ToolResult<unknown> {
  return {
    toolName,
    timestamp: new Date().toISOString(),
    source,
    visibility: Visibility.PUBLIC,
    correlationId: 'corr-test',
    error: { code, message, retryable: true },
  };
}

// ---------------------------------------------------------------------------
// Mock tools
// ---------------------------------------------------------------------------

export class MockTool implements Tool {
  public calls: Array<{ params: Record<string, unknown>; ctx: ToolCallContext }> = [];

  constructor(
    public readonly meta: ToolMetadata,
    private readonly handler: (
      params: Record<string, unknown>,
      ctx: ToolCallContext,
    ) => Promise<ToolResult<unknown>> | ToolResult<unknown>,
  ) {}

  async execute(
    params: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    this.calls.push({ params, ctx });
    return this.handler(params, ctx);
  }

  get callCount(): number {
    return this.calls.length;
  }
}

function baseMeta(
  name: string,
  overrides: Partial<ToolMetadata> = {},
): ToolMetadata {
  return {
    name,
    description: `mock ${name}`,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'query' } },
      required: ['query'],
    },
    privacySensitive: false,
    maxVisibility: Visibility.PUBLIC,
    ...overrides,
  };
}

export const knowledgeSearchMeta = baseMeta('knowledge.search', {
  description: 'mock knowledge search (tier B)',
  verificationTier: 'B',
});

export const docsSearchMeta = baseMeta('docs.search', {
  description: 'mock docs search (tier B)',
  verificationTier: 'B',
});

export const memoryGetMeta = baseMeta('memory.get', {
  description: 'mock memory read (tier C)',
  verificationTier: 'C',
  maxVisibility: Visibility.STAFF,
});

export const identityLookupMeta = baseMeta('identity.lookup', {
  description: 'mock identity lookup (tier A, privacy-sensitive)',
  verificationTier: 'A',
  privacySensitive: true,
  maxVisibility: Visibility.PLAYER_SELF,
});

export const permissionLookupMeta = baseMeta('db.permission_lookup', {
  description: 'mock permission lookup (tier A, privacy-sensitive)',
  verificationTier: 'A',
  privacySensitive: true,
  maxVisibility: Visibility.PLAYER_SELF,
});

export const serverStatusMeta = baseMeta('server.status', {
  description: 'mock live server status (tier A)',
  verificationTier: 'A',
});

/** Registry pre-loaded with the standard mock tools. */
export function mockRegistry(tools: MockTool[]): {
  registry: ToolRegistry;
  byName: Map<string, MockTool>;
} {
  const registry = new ToolRegistry();
  const byName = new Map<string, MockTool>();
  for (const tool of tools) {
    registry.register(tool);
    byName.set(tool.meta.name, tool);
  }
  return { registry, byName };
}

// ---------------------------------------------------------------------------
// Mock reasoner
// ---------------------------------------------------------------------------

export interface ReasonerScript {
  classification: IntentClassification;
  plan: EvidencePlanStep[];
  /** Consumed in order by nextStep; defaults to finish when exhausted. */
  decisions: InvestigationDecision[];
  draft?: ResponseDraft;
}

/** Scripted reasoner: deterministic, no model calls. */
export class MockReasoner implements Reasoner {
  public snapshots: InvestigationSnapshot[] = [];
  public draftArgs: DraftArgs[] = [];
  public classifyCalls = 0;
  public planCalls = 0;
  private decisionIndex = 0;

  constructor(private readonly script: ReasonerScript) {}

  async classifyIntent(): Promise<IntentClassification> {
    this.classifyCalls += 1;
    return structuredClone(this.script.classification);
  }

  async planEvidence(): Promise<EvidencePlanStep[]> {
    this.planCalls += 1;
    return structuredClone(this.script.plan);
  }

  async nextStep(snapshot: InvestigationSnapshot): Promise<InvestigationDecision> {
    this.snapshots.push(snapshot);
    const decision = this.script.decisions[this.decisionIndex];
    this.decisionIndex += 1;
    return structuredClone(
      decision ?? { action: 'finish', calls: [] },
    ) as InvestigationDecision;
  }

  async draftResponse(args: DraftArgs): Promise<ResponseDraft> {
    this.draftArgs.push(args);
    return structuredClone(this.script.draft ?? {});
  }
}

function structuredClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

export function playerActor(overrides: Partial<Actor> = {}): Actor {
  return { id: 'player-1', type: 'player', displayName: 'TestPlayer', ...overrides };
}

export function makeRequest(
  message: string,
  overrides: Partial<ChatRequest> = {},
): ChatRequest {
  return {
    surface: 'discord',
    actor: playerActor(),
    conversationId: 'conv-1',
    message,
    visibilityCeiling: Visibility.PUBLIC,
    traceId: newTraceId(),
    ...overrides,
  };
}

export function simpleClassification(
  overrides: Partial<IntentClassification> = {},
): IntentClassification {
  return {
    requestClass: 'simple',
    summary: 'test summary',
    claims: ['server IP'],
    needsPrivateContext: false,
    securitySensitive: false,
    ...overrides,
  };
}

/** One tool call serving one claim. */
export function callTool(
  toolName: string,
  claim: string,
  params: Record<string, unknown> = { query: 'test query' },
): InvestigationDecision {
  return {
    action: 'call_tools',
    calls: [{ toolName, params, claim }],
  };
}

export const FINISH: InvestigationDecision = { action: 'finish', calls: [] };
