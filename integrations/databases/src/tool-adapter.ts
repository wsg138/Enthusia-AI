/**
 * @enthusia/integration-databases — W12 tool-interface adapter (W10).
 *
 * These interfaces are a STRUCTURAL MIRROR of the Tool contract defined by
 * W12 in `services/agent-core/src/tool.ts` (ToolMetadata, ToolCallContext,
 * Tool, ToolParameterProperty, ToolParametersSchema, VerificationTier).
 *
 * Why a mirror instead of an import: the dependency direction is W10 plugs
 * INTO W12. `services/agent-core` is not a dependency of this package, so the
 * shapes are duplicated here and pinned by test/tool-conformance.test.ts.
 * If W12 changes its Tool interface, this file must be updated to match —
 * the conformance test documents the exact W12 source revision it was
 * synced against.
 *
 * DO NOT modify W12's code from this workstream.
 */
import type {
  Actor,
  ToolResult,
  Visibility,
} from '@enthusia/contracts';

/**
 * Synced against W12 services/agent-core/src/tool.ts (branch
 * w12/agent-orchestrator, PR #14): VerificationTier = 'A' | 'B' | 'C'.
 * Database tools are Tier A (live lookup, §11.2).
 */
export type VerificationTier = 'A' | 'B' | 'C';

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
  /** Unique tool name, e.g. `db.permission_state`. */
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
 */
export interface Tool<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly meta: ToolMetadata;
  execute(params: TParams, ctx: ToolCallContext): Promise<ToolResult<unknown>>;
}

/**
 * Base class for the W10 database tools. Handles the ToolResult envelope and
 * leaves param parsing, querying, and payload mapping to subclasses.
 */
export abstract class DatabaseTool<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> implements Tool<TParams>
{
  abstract readonly meta: ToolMetadata;
  abstract execute(
    params: TParams,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>>;
}
