import { z } from 'zod';
import { Visibility } from './visibility.js';

/**
 * Tool result provenance envelope.
 *
 * Spec: MASTER-SPECIFICATION.md §16.2.
 * Every tool result carries name, timestamp, source, visibility, request
 * correlation ID, and freshness/version where applicable.
 */
export interface ToolErrorInfo {
  /** Machine-readable error code (see errors.ts). */
  code: string;
  /** Human-readable, visibility-safe message. */
  message: string;
  /** Whether the call may be retried. */
  retryable: boolean;
}

export interface ToolResult<T = unknown> {
  /** Tool class/name, e.g. 'knowledge.search', 'github.getFile'. */
  toolName: string;
  /** ISO 8601 timestamp of result production. */
  timestamp: string;
  /** Identity of the tool/source that produced the result. */
  source: string;
  visibility: Visibility;
  /** Request correlation (trace) ID. */
  correlationId: string;
  /** Version/hash/timestamp of the underlying data where applicable. */
  freshness?: string;
  /** Payload; absent when `error` is set. */
  result?: T;
  /** Error detail; absent on success. */
  error?: ToolErrorInfo;
}

export const toolErrorInfoSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});

export const toolResultSchema = z.object({
  toolName: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  source: z.string().min(1),
  visibility: z.nativeEnum(Visibility),
  correlationId: z.string().min(1),
  freshness: z.string().optional(),
  result: z.unknown().optional(),
  error: toolErrorInfoSchema.optional(),
});
