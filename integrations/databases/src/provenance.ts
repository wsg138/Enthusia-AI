/**
 * @enthusia/integration-databases — ToolResult provenance builder (W10).
 *
 * Spec: MASTER-SPECIFICATION.md §16.2. Every tool result carries tool name,
 * timestamp, source, visibility, request correlation ID, and freshness/version
 * where applicable.
 */
import type { ToolErrorInfo, ToolResult, Visibility } from '@enthusia/contracts';
import type { QueryTemplateName } from './query-templates.js';

/** Freshness/version block encoded as JSON in ToolResult.freshness. */
export interface DatabaseFreshness {
  /** ISO 8601 time the rows were observed. */
  readonly observedAt: string;
  /** Live queries are always CURRENT at observation time (§5.1). */
  readonly sourceStatus: 'CURRENT';
  /** Which registered template produced the rows. */
  readonly queryTemplate: QueryTemplateName;
  readonly rowCount: number;
  readonly truncated: boolean;
}

export function encodeFreshness(freshness: DatabaseFreshness): string {
  return JSON.stringify(freshness);
}

export function decodeFreshness(encoded: string): DatabaseFreshness {
  return JSON.parse(encoded) as DatabaseFreshness;
}

export interface ProvenanceFields {
  readonly toolName: string;
  /** Identity of the live source, e.g. 'database:live:account_links'. */
  readonly source: string;
  readonly visibility: Visibility;
  readonly correlationId: string;
  readonly freshness: DatabaseFreshness;
}

/** Build a successful ToolResult envelope with full §16.2 provenance. */
export function buildToolResult<T>(
  provenance: ProvenanceFields,
  result: T,
): ToolResult<T> {
  return {
    toolName: provenance.toolName,
    timestamp: new Date().toISOString(),
    source: provenance.source,
    visibility: provenance.visibility,
    correlationId: provenance.correlationId,
    freshness: encodeFreshness(provenance.freshness),
    result,
  };
}

/** Build a failed ToolResult envelope. No payload, visibility-safe message. */
export function buildToolError(
  provenance: Omit<ProvenanceFields, 'freshness'>,
  error: ToolErrorInfo,
): ToolResult<never> {
  return {
    toolName: provenance.toolName,
    timestamp: new Date().toISOString(),
    source: provenance.source,
    visibility: provenance.visibility,
    correlationId: provenance.correlationId,
    error,
  };
}
