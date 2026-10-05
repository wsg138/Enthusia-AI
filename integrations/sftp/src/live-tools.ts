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

interface LiveToolDefinition {
  meta: ToolMetadata;
  keys: readonly string[];
  invoke: (
    gateway: LiveServerSourceGateway,
    params: Readonly<Record<string, string>>,
    options: LiveReadOptions,
  ) => Promise<LiveSourceResult<unknown>>;
}

function liveReadOptions(ctx: ToolCallContext): LiveReadOptions {
  return ctx.signal === undefined ? {} : { signal: ctx.signal };
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
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, description]) => [
        name,
        { type: 'string' as const, description },
      ]),
    ),
    required: Object.keys(properties),
  };
}

function staffAuthorized(ctx: ToolCallContext): boolean {
  const staffActor = ctx.actor.type === 'staff' || ctx.actor.type === 'system';
  if (!staffActor) return false;
  return canDisclose(STAFF_TOOL_VISIBILITY, ctx.visibilityCeiling, { isStaff: true });
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
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(result), 'utf8')
    .digest('hex');
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
    result: {
      server: output.server,
      data: output.result,
    },
  };
}

function meta(
  name: string,
  description: string,
  properties: Record<string, string>,
): ToolMetadata {
  return {
    name,
    description,
    parameters: parameterSchema(properties),
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: STAFF_TOOL_VISIBILITY,
  };
}

const DEFINITIONS: readonly LiveToolDefinition[] = [
  {
    meta: meta(
      'server.list_plugins',
      'List deployed plugin JAR identities in one configured plugin directory.',
      {
        serverId: 'Configured server identity.',
        directoryId: 'Configured plugin-directory identity.',
      },
    ),
    keys: ['serverId', 'directoryId'],
    invoke: (gateway, params, options) => gateway.listPlugins(
      params['serverId'] ?? '',
      params['directoryId'] ?? '',
      options,
    ),
  },
  {
    meta: meta(
      'server.inspect_plugin',
      'Inspect safe metadata from one deployed JAR selected by basename.',
      {
        serverId: 'Configured server identity.',
        directoryId: 'Configured plugin-directory identity.',
        fileName: 'JAR basename returned by server.list_plugins.',
      },
    ),
    keys: ['serverId', 'directoryId', 'fileName'],
    invoke: (gateway, params, options) => gateway.inspectPlugin(
      params['serverId'] ?? '',
      params['directoryId'] ?? '',
      params['fileName'] ?? '',
      options,
    ),
  },
  {
    meta: meta(
      'server.discover_configs',
      'Discover safe config-file identities below one configured directory.',
      {
        serverId: 'Configured server identity.',
        directoryId: 'Configured config-directory identity.',
      },
    ),
    keys: ['serverId', 'directoryId'],
    invoke: (gateway, params, options) => gateway.discoverConfigs(
      params['serverId'] ?? '',
      params['directoryId'] ?? '',
      options,
    ),
  },
  {
    meta: meta(
      'server.read_approved_file',
      'Read one explicitly configured server/config/deployment source by source ID.',
      {
        serverId: 'Configured server identity.',
        sourceId: 'Configured approved-file identity. Filesystem paths are not accepted.',
      },
    ),
    keys: ['serverId', 'sourceId'],
    invoke: (gateway, params, options) => gateway.readApprovedFile(
      params['serverId'] ?? '',
      params['sourceId'] ?? '',
      options,
    ),
  },
];

class ConfiguredLiveSourceTool implements Tool<Record<string, unknown>> {
  readonly meta: ToolMetadata;

  constructor(
    private readonly gateway: LiveServerSourceGateway,
    private readonly definition: LiveToolDefinition,
  ) {
    this.meta = definition.meta;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    if (!staffAuthorized(ctx)) return this.unauthorized(ctx);
    const parsed = stringParams(params, this.definition.keys);
    if (parsed === null) return this.invalidParams(ctx);

    const output = await this.definition.invoke(
      this.gateway,
      parsed,
      liveReadOptions(ctx),
    );
    return toToolResult(this.meta, ctx, output);
  }

  private unauthorized(ctx: ToolCallContext): ToolResult<unknown> {
    return safeError(
      this.meta.name,
      ctx,
      'sftp-live',
      'VISIBILITY_DENIED',
      'live server source is restricted to authorized staff/system context',
      false,
    );
  }

  private invalidParams(ctx: ToolCallContext): ToolResult<unknown> {
    return safeError(
      this.meta.name,
      ctx,
      'sftp-live',
      'INVALID_PARAMS',
      'parameters did not match the typed tool contract',
      false,
    );
  }
}

export class LiveServerSourceToolset {
  readonly tools: Tool<Record<string, unknown>>[];
  private readonly byName: Map<string, Tool<Record<string, unknown>>>;

  constructor(gateway: LiveServerSourceGateway) {
    this.tools = DEFINITIONS.map(
      (definition) => new ConfiguredLiveSourceTool(gateway, definition),
    );
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
