/**
 * @enthusia/agent-core — tool interface and dependency-injection registry (W12).
 *
 * Spec: MASTER-SPECIFICATION.md §16 (tool system), §16.2 (tool result
 * provenance), §17 (visibility). All powerful access is exposed through typed
 * tools; the model never receives raw credentials (§5.5).
 *
 * Tools are injected: W10 (database tools), W08 (GitHub), W07 (retrieval),
 * W05 (memory), W11 (identity) etc. register their tools here. The
 * orchestrator only ever calls tools present in the registry.
 */
import type {
  Actor,
  ToolResult,
  Visibility,
} from '@enthusia/contracts';
import type { VerificationTier } from './types.js';

/** One JSON-schema-like parameter declaration. */
export interface ToolParameterProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
}

/** Minimal structural schema for tool parameters. */
export interface ToolParametersSchema {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

/**
 * Static metadata every tool must declare.
 *
 * `privacySensitive` marks tools that can return private/identity-scoped data
 * (identity linkage, balances, ticket contents, ...). The orchestrator's
 * privacy gate refuses such tools unless the intent classification says the
 * request legitimately needs private context (§15.3 bounded curiosity).
 */
export interface ToolMetadata {
  /** Unique tool name, e.g. `knowledge.search`, `db.permission_lookup`. */
  name: string;
  description: string;
  parameters: ToolParametersSchema;
  /** Verification tier of the tool's underlying source (§11.2), when known. */
  verificationTier?: VerificationTier;
  /** True when the tool can return private/identity-scoped data. */
  privacySensitive: boolean;
  /** Most sensitive visibility this tool may return (§17). */
  maxVisibility: Visibility;
}

/** Per-call context handed to every tool execution. */
export interface ToolCallContext {
  /** Request correlation ID, propagated end-to-end (§16.2). */
  traceId: string;
  actor: Actor;
  /** Caps the sensitivity of anything the tool may return (§17). */
  visibilityCeiling: Visibility;
  /** Aborts the call when the orchestrator's per-tool timeout elapses. */
  signal?: AbortSignal;
}

/**
 * A typed tool the orchestrator may call.
 *
 * Implementations must return a {@link ToolResult} carrying the §16.2
 * provenance fields (tool name, timestamp, source, visibility, correlation
 * ID, freshness/version). They must never leak secrets in payloads or error
 * messages (§5.5, §17.6).
 *
 * Freshness convention: encode {@link FreshnessInfo} (see freshness.ts) as
 * JSON in `ToolResult.freshness` so the orchestrator can verify currency.
 */
export interface Tool<TParams extends Record<string, unknown> = Record<string, unknown>> {
  readonly meta: ToolMetadata;
  execute(params: TParams, ctx: ToolCallContext): Promise<ToolResult<unknown>>;
}

/**
 * Dependency-injection registry for tools.
 *
 * Workstreams that own tools (W05 memory, W07 retrieval, W08 GitHub,
 * W10 database, W11 identity, ...) register instances here; the
 * orchestrator discovers tools only through this registry.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /** Register a tool. Throws on duplicate name (fail fast, no shadowing). */
  register(tool: Tool): void {
    if (this.tools.has(tool.meta.name)) {
      throw new Error(`tool already registered: ${tool.meta.name}`);
    }
    this.tools.set(tool.meta.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Metadata of every registered tool (handed to the reasoner for planning). */
  list(): ToolMetadata[] {
    return [...this.tools.values()].map((t) => t.meta);
  }

  get size(): number {
    return this.tools.size;
  }
}

/**
 * Light structural validation of proposed params against the tool's schema.
 * Returns human-readable problems; empty means valid. This is a guardrail,
 * not a full JSON-schema implementation.
 */
export function validateToolParams(
  meta: ToolMetadata,
  params: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return ['params must be an object'];
  }
  for (const name of meta.parameters.required ?? []) {
    if (!(name in params) || params[name] === undefined) {
      problems.push(`missing required param: ${name}`);
    }
  }
  for (const [name, value] of Object.entries(params)) {
    const decl = meta.parameters.properties[name];
    if (!decl) {
      problems.push(`unknown param: ${name}`);
      continue;
    }
    if (value === undefined) continue;
    if (!matchesParamType(decl.type, value)) {
      problems.push(`param ${name} should be ${decl.type}`);
    } else if (decl.enum && typeof value === 'string' && !decl.enum.includes(value)) {
      problems.push(`param ${name} must be one of: ${decl.enum.join(', ')}`);
    }
  }
  return problems;
}

function matchesParamType(
  type: ToolParameterProperty['type'],
  value: unknown,
): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
