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
import {
  readCurrentPluginDeployment,
  readCurrentPluginInterface,
  readCurrentTargetFreshness,
} from './current-intelligence.js';
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

function hasOnlyKeys(
  raw: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(raw).every((key) => keys.includes(key));
}

function requiredString(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  return value.trim().length === 0 ? undefined : value;
}

function stringParams(
  raw: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> | null {
  if (!hasOnlyKeys(raw, keys)) return null;
  const parsed: Record<string, string> = {};
  for (const key of keys) {
    const value = requiredString(raw, key);
    if (value === undefined) return null;
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

function staffActor(ctx: ToolCallContext): boolean {
  return ctx.actor.type === 'staff' || ctx.actor.type === 'system';
}

function staffAuthorized(ctx: ToolCallContext): boolean {
  if (!staffActor(ctx)) return false;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined;
}

function provenanceVersion(result: unknown): string | undefined {
  const provenance = asRecord(result)?.['provenance'];
  const file = asRecord(provenance)?.['file'];
  const version = asRecord(file)?.['version'];
  return typeof version === 'string' ? version : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function boundedText(value: string, max = 4000): string {
  return value.length <= max ? value : value.slice(0, max) + '…';
}

interface CurrentEvidenceValue {
  value: string;
  excerpt: string;
}

function evidenceExcerpt(result: unknown): string {
  return boundedText(JSON.stringify(result));
}

function labeledField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? label + '=' + value : undefined;
}

function deploymentEvidence(
  root: Record<string, unknown>,
  result: unknown,
): CurrentEvidenceValue | undefined {
  const plugin = asRecord(root['plugin']);
  const deployed = asRecord(root['deployed']);
  if (plugin === undefined || deployed === undefined) return undefined;

  const fields = [
    labeledField(plugin, 'name', 'plugin'),
    labeledField(plugin, 'version', 'version'),
    labeledField(plugin, 'mainClass', 'main'),
    labeledField(deployed, 'fileName', 'file'),
    labeledField(deployed, 'sha256', 'sha256'),
    labeledField(deployed, 'modifiedAt', 'modifiedAt'),
  ].filter((item): item is string => item !== undefined);
  if (fields.length === 0) return undefined;

  return {
    value: boundedText(fields.join('; '), 2000),
    excerpt: evidenceExcerpt(result),
  };
}

function freshnessEvidence(
  root: Record<string, unknown>,
  result: unknown,
): CurrentEvidenceValue | undefined {
  const anchor = asRecord(root['anchor']);
  const state = root['state'];
  if (typeof state !== 'string' || anchor === undefined) return undefined;

  const fileName = labeledField(anchor, 'fileName', 'anchor') ?? 'anchor=unknown';
  const modifiedAt =
    labeledField(anchor, 'modifiedAt', 'modifiedAt') ?? 'modifiedAt=unknown';
  return {
    value: 'state=' + state + '; ' + fileName + '; ' + modifiedAt,
    excerpt: evidenceExcerpt(result),
  };
}

function interfaceEvidence(
  root: Record<string, unknown>,
  result: unknown,
): CurrentEvidenceValue | undefined {
  const plugin = asRecord(root['plugin']);
  if (plugin === undefined) return undefined;

  const commands = stringArray(root['declaredCommands']);
  const permissions = stringArray(root['declaredPermissions']);
  const fields = [
    labeledField(plugin, 'name', 'plugin'),
    labeledField(plugin, 'version', 'version'),
    'declaredCommands=' + (commands.length > 0 ? commands.join(',') : '(none)'),
    'declaredPermissions=' + (permissions.length > 0 ? permissions.join(',') : '(none)'),
    'caveat=metadata declarations do not prove runtime registration',
  ].filter((item): item is string => item !== undefined);

  return {
    value: boundedText(fields.join('; '), 3000),
    excerpt: evidenceExcerpt(result),
  };
}

function configValueEvidence(
  root: Record<string, unknown>,
  result: unknown,
): CurrentEvidenceValue | undefined {
  const sourceId = root['sourceId'];
  const valueKey = root['valueKey'];
  const value = root['value'];
  if (typeof sourceId !== 'string' || typeof valueKey !== 'string') {
    return undefined;
  }
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    return undefined;
  }

  return {
    value: boundedText(
      'source=' + sourceId +
      '; key=' + valueKey +
      '; value=' + JSON.stringify(value),
      3000,
    ),
    excerpt: evidenceExcerpt(result),
  };
}

function currentEvidenceValue(
  toolName: string,
  result: unknown,
): CurrentEvidenceValue | undefined {
  const root = asRecord(result);
  if (root === undefined) return undefined;

  switch (toolName) {
    case 'server.current_plugin_deployment':
      return deploymentEvidence(root, result);
    case 'server.current_target_freshness':
      return freshnessEvidence(root, result);
    case 'server.current_plugin_interface':
      return interfaceEvidence(root, result);
    case 'server.current_config_value':
      return configValueEvidence(root, result);
    default:
      return undefined;
  }
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
  const evidence = currentEvidenceValue(meta.name, output.result);
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
      ...(evidence !== undefined
        ? { value: evidence.value, excerpt: evidence.excerpt }
        : {}),
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
      'server.current_plugin_deployment',
      'Return a compact current deployment identity for one deployed plugin JAR.',
      {
        serverId: 'Configured server identity.',
        directoryId: 'Configured plugin-directory identity.',
        fileName: 'JAR basename returned by server.list_plugins.',
      },
    ),
    keys: ['serverId', 'directoryId', 'fileName'],
    invoke: (gateway, params, options) => readCurrentPluginDeployment(
      gateway,
      params['serverId'] ?? '',
      params['directoryId'] ?? '',
      params['fileName'] ?? '',
      options,
    ),
  },
  {
    meta: meta(
      'server.current_target_freshness',
      'Verify the live read path using one explicit deployed plugin JAR as an anchor.',
      {
        serverId: 'Configured server identity.',
        directoryId: 'Configured plugin-directory identity.',
        fileName: 'Known deployed JAR basename used as the freshness anchor.',
      },
    ),
    keys: ['serverId', 'directoryId', 'fileName'],
    invoke: (gateway, params, options) => readCurrentTargetFreshness(
      gateway,
      params['serverId'] ?? '',
      params['directoryId'] ?? '',
      params['fileName'] ?? '',
      options,
    ),
  },
  {
    meta: meta(
      'server.current_plugin_interface',
      'Return declared command and permission keys from the currently deployed plugin JAR.',
      {
        serverId: 'Configured server identity.',
        directoryId: 'Configured plugin-directory identity.',
        fileName: 'JAR basename returned by server.list_plugins.',
      },
    ),
    keys: ['serverId', 'directoryId', 'fileName'],
    invoke: (gateway, params, options) => readCurrentPluginInterface(
      gateway,
      params['serverId'] ?? '',
      params['directoryId'] ?? '',
      params['fileName'] ?? '',
      options,
    ),
  },
  {
    meta: meta(
      'server.current_config_value',
      'Return one explicitly allowlisted scalar from a current approved config source.',
      {
        serverId: 'Configured server identity.',
        sourceId: 'Configured approved-file identity.',
        valueKey: 'Configured safe-value alias; raw config paths are not accepted.',
      },
    ),
    keys: ['serverId', 'sourceId', 'valueKey'],
    invoke: (gateway, params, options) => gateway.readApprovedConfigValue(
      params['serverId'] ?? '',
      params['sourceId'] ?? '',
      params['valueKey'] ?? '',
      options,
    ),
  },
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
