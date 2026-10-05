/**
 * Staff-gated typed tools for the live server source.
 *
 * This is the model-facing boundary. It exposes no raw SFTP client, connection
 * configuration, credentials, or arbitrary filesystem path parameter.
 */

import { createHash } from 'node:crypto';
import {
  SourceStatus,
  Visibility,
  canDisclose,
  type ToolResult,
} from '@enthusia/contracts';
import {
  LiveServerSourceGateway,
  type LiveReadOptions,
  type LiveSourceResult,
} from './live-source.js';
import type {
  Tool,
  ToolCallContext,
  ToolMetadata,
  ToolParametersSchema,
} from './tool-adapter.js';

const STAFF_TOOL_VISIBILITY = Visibility.STAFF;

function liveReadOptions(ctx: ToolCallContext): LiveReadOptions {
  return ctx.signal === undefined ? {} : liveReadOptions(ctx);
}

function stringParams(
  raw: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> | null {
  if (Object.keys(raw).some((key) => !keys.includes(key))) return null;
  const parsed: Record<string, string> = {};
  for (const key of keys) {
    const value = raw[key];
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    parsed[key] = value;
  }
  return parsed;
}

function parameterSchema(
  properties: Record<string, string>,
): ToolParametersSchema {
  const schemaProperties: ToolParametersSchema['properties'] = {};
  for (const [name, description] of Object.entries(properties)) {
    schemaProperties[name] = { type: 'string', description };
  }
  return {
    type: 'object',
    properties: schemaProperties,
    required: Object.keys(properties),
  };
}

function staffAuthorized(ctx: ToolCallContext): boolean {
  const staffActor = ctx.actor.type === 'staff' || ctx.actor.type === 'system';
  return staffActor && canDisclose(
    STAFF_TOOL_VISIBILITY,
    ctx.visibilityCeiling,
    { isStaff: true },
  );
}

function safeError(
  toolName: string,
  ctx: ToolCallContext,
  source: string,
  code: string,
  message: string,
  retryable: boolean,
): ToolResult<unknown> {
  return {
    toolName,
    timestamp: new Date().toISOString(),
    source,
    visibility: STAFF_TOOL_VISIBILITY,
    correlationId: ctx.traceId,
    error: { code, message, retryable },
  };
}

function collectionVersion(result: unknown): string {
  const serialized = JSON.stringify(result);
  return 'sha256:' + createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function encodeFreshness(version: string, observedAt: string): string {
  return JSON.stringify({
    version,
    observedTime: observedAt,
    sourceStatus: SourceStatus.CURRENT,
  });
}

function provenanceVersion(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const provenance = (result as Record<string, unknown>)['provenance'];
  if (provenance === null || typeof provenance !== 'object') return undefined;
  const file = (provenance as Record<string, unknown>)['file'];
  if (file === null || typeof file !== 'object') return undefined;
  const version = (file as Record<string, unknown>)['version'];
  return typeof version === 'string' ? version : undefined;
}

function toToolResult(
  meta: ToolMetadata,
  ctx: ToolCallContext,
  output: LiveSourceResult<unknown>,
): ToolResult<unknown> {
  const source = 'sftp-live:' + output.server.id;
  if (!output.ok) {
    return safeError(
      meta.name,
      ctx,
      source,
      output.error.code,
      output.error.message,
      output.error.retryable,
    );
  }

  const version = provenanceVersion(output.result) ?? collectionVersion(output.result);
  return {
    toolName: meta.name,
    timestamp: output.observedAt,
    source,
    visibility: STAFF_TOOL_VISIBILITY,
    correlationId: ctx.traceId,
    freshness: encodeFreshness(version, output.observedAt),
    result: output.result,
  };
}

abstract class LiveSourceTool implements Tool<Record<string, unknown>> {
  abstract readonly meta: ToolMetadata;

  constructor(protected readonly gateway: LiveServerSourceGateway) {}

  protected rejectUnauthorized(ctx: ToolCallContext): ToolResult<unknown> | undefined {
    if (staffAuthorized(ctx)) return undefined;
    return safeError(
      this.meta.name,
      ctx,
      'sftp-live',
      'VISIBILITY_DENIED',
      'live server source is restricted to authorized staff/system context',
      false,
    );
  }

  protected invalidParams(ctx: ToolCallContext): ToolResult<unknown> {
    return safeError(
      this.meta.name,
      ctx,
      'sftp-live',
      'INVALID_PARAMS',
      'parameters did not match the typed tool contract',
      false,
    );
  }

  protected finish(
    ctx: ToolCallContext,
    output: LiveSourceResult<unknown>,
  ): ToolResult<unknown> {
    return toToolResult(this.meta, ctx, output);
  }

  abstract execute(
    params: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>>;
}

class ListPluginsTool extends LiveSourceTool {
  readonly meta: ToolMetadata = {
    name: 'server.list_plugins',
    description: 'List deployed plugin JAR identities in one configured plugin directory.',
    parameters: parameterSchema({
      serverId: 'Configured server identity.',
      directoryId: 'Configured plugin-directory identity.',
    }),
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: STAFF_TOOL_VISIBILITY,
  };

  async execute(
    params: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const denied = this.rejectUnauthorized(ctx);
    if (denied !== undefined) return denied;
    const parsed = stringParams(params, ['serverId', 'directoryId']);
    if (parsed === null) return this.invalidParams(ctx);
    const output = await this.gateway.listPlugins(
      parsed['serverId'] as string,
      parsed['directoryId'] as string,
      liveReadOptions(ctx),
    );
    return this.finish(ctx, output);
  }
}

class InspectPluginTool extends LiveSourceTool {
  readonly meta: ToolMetadata = {
    name: 'server.inspect_plugin',
    description: 'Inspect safe metadata from one deployed JAR selected by basename.',
    parameters: parameterSchema({
      serverId: 'Configured server identity.',
      directoryId: 'Configured plugin-directory identity.',
      fileName: 'JAR basename returned by server.list_plugins.',
    }),
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: STAFF_TOOL_VISIBILITY,
  };

  async execute(
    params: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const denied = this.rejectUnauthorized(ctx);
    if (denied !== undefined) return denied;
    const parsed = stringParams(params, ['serverId', 'directoryId', 'fileName']);
    if (parsed === null) return this.invalidParams(ctx);
    const output = await this.gateway.inspectPlugin(
      parsed['serverId'] as string,
      parsed['directoryId'] as string,
      parsed['fileName'] as string,
      liveReadOptions(ctx),
    );
    return this.finish(ctx, output);
  }
}

class DiscoverConfigsTool extends LiveSourceTool {
  readonly meta: ToolMetadata = {
    name: 'server.discover_configs',
    description: 'Discover safe config-file identities below one configured directory.',
    parameters: parameterSchema({
      serverId: 'Configured server identity.',
      directoryId: 'Configured config-directory identity.',
    }),
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: STAFF_TOOL_VISIBILITY,
  };

  async execute(
    params: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const denied = this.rejectUnauthorized(ctx);
    if (denied !== undefined) return denied;
    const parsed = stringParams(params, ['serverId', 'directoryId']);
    if (parsed === null) return this.invalidParams(ctx);
    const output = await this.gateway.discoverConfigs(
      parsed['serverId'] as string,
      parsed['directoryId'] as string,
      liveReadOptions(ctx),
    );
    return this.finish(ctx, output);
  }
}

class ReadApprovedFileTool extends LiveSourceTool {
  readonly meta: ToolMetadata = {
    name: 'server.read_approved_file',
    description: 'Read one explicitly configured server/config/deployment source by source ID.',
    parameters: parameterSchema({
      serverId: 'Configured server identity.',
      sourceId: 'Configured approved-file identity. Filesystem paths are not accepted.',
    }),
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: STAFF_TOOL_VISIBILITY,
  };

  async execute(
    params: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const denied = this.rejectUnauthorized(ctx);
    if (denied !== undefined) return denied;
    const parsed = stringParams(params, ['serverId', 'sourceId']);
    if (parsed === null) return this.invalidParams(ctx);
    const output = await this.gateway.readApprovedFile(
      parsed['serverId'] as string,
      parsed['sourceId'] as string,
      liveReadOptions(ctx),
    );
    return this.finish(ctx, output);
  }
}

export class LiveServerSourceToolset {
  readonly tools: Tool<Record<string, unknown>>[];
  private readonly byName: Map<string, Tool<Record<string, unknown>>>;

  constructor(gateway: LiveServerSourceGateway) {
    this.tools = [
      new ListPluginsTool(gateway),
      new InspectPluginTool(gateway),
      new DiscoverConfigsTool(gateway),
      new ReadApprovedFileTool(gateway),
    ];
    this.byName = new Map(this.tools.map((tool) => [tool.meta.name, tool]));
  }

  get(name: string): Tool<Record<string, unknown>> | undefined {
    return this.byName.get(name);
  }

  get names(): string[] {
    return this.tools.map((tool) => tool.meta.name);
  }
}

export function createLiveServerSourceTools(
  gateway: LiveServerSourceGateway,
): LiveServerSourceToolset {
  return new LiveServerSourceToolset(gateway);
}
