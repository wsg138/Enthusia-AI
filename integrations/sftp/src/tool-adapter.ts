/**
 * Structural mirror of services/agent-core/src/tool.ts.
 *
 * The SFTP integration plugs into agent-core but does not depend on it. Tests
 * pin this shape so interface drift fails loudly.
 */

import type {
  Actor,
  ToolResult,
  Visibility,
} from '@enthusia/contracts';

export type VerificationTier = 'A' | 'B' | 'C';

export interface ToolParameterProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
}

export interface ToolParametersSchema {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolMetadata {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
  verificationTier?: VerificationTier;
  privacySensitive: boolean;
  maxVisibility: Visibility;
}

export interface ToolCallContext {
  traceId: string;
  actor: Actor;
  visibilityCeiling: Visibility;
  signal?: AbortSignal;
}

export interface Tool<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly meta: ToolMetadata;
  execute(params: TParams, ctx: ToolCallContext): Promise<ToolResult<unknown>>;
}
