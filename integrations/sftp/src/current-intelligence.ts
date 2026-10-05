import type { LiveServerSourceGateway } from './live-source.js';
import type {
  LiveReadOptions,
  LiveSourceResult,
  PluginInspectionResult,
} from './live-types.js';

export interface CurrentPluginDeployment {
  directoryId: string;
  evidence: 'deployed-jar-inspection';
  plugin: {
    status: PluginInspectionResult['plugin']['status'];
    name?: string;
    version?: string;
    mainClass?: string;
  };
  deployed: {
    fileName: string;
    sha256: string;
    sizeBytes: number;
    modifiedAt: string;
  };
  source: {
    gitSource: PluginInspectionResult['gitSource'];
    buildArtifact: PluginInspectionResult['buildArtifact'];
    runtimeIdentity: PluginInspectionResult['runtimeIdentity'];
  };
  dependencies: {
    required: string[];
    optional: string[];
    loadBefore: string[];
  };
}

export interface CurrentTargetFreshness {
  directoryId: string;
  state: 'CURRENT';
  scope: 'read-path';
  evidence: 'live-plugin-inspection';
  anchor: {
    fileName: string;
    sha256: string;
    modifiedAt: string;
  };
}

export interface CurrentPluginInterface {
  directoryId: string;
  evidence: 'deployed-plugin-metadata';
  plugin: {
    status: PluginInspectionResult['plugin']['status'];
    name?: string;
    version?: string;
  };
  deployed: {
    fileName: string;
    sha256: string;
  };
  declaredCommands: string[];
  declaredPermissions: string[];
  caveat: 'metadata-declarations-do-not-prove-runtime-registration';
}

function mapSuccess<TSource, TMapped>(
  source: LiveSourceResult<TSource>,
  map: (value: TSource) => TMapped,
): LiveSourceResult<TMapped> {
  if (!source.ok) return source;
  return {
    ok: true,
    server: source.server,
    observedAt: source.observedAt,
    result: map(source.result),
  };
}

function definedFields(
  plugin: PluginInspectionResult['plugin'],
): CurrentPluginDeployment['plugin'] {
  const value: CurrentPluginDeployment['plugin'] = { status: plugin.status };
  if (plugin.name !== undefined) value.name = plugin.name;
  if (plugin.version !== undefined) value.version = plugin.version;
  if (plugin.mainClass !== undefined) value.mainClass = plugin.mainClass;
  return value;
}

function interfacePlugin(
  plugin: PluginInspectionResult['plugin'],
): CurrentPluginInterface['plugin'] {
  const value: CurrentPluginInterface['plugin'] = { status: plugin.status };
  if (plugin.name !== undefined) value.name = plugin.name;
  if (plugin.version !== undefined) value.version = plugin.version;
  return value;
}

function deploymentResult(
  inspected: PluginInspectionResult,
): CurrentPluginDeployment {
  return {
    directoryId: inspected.directoryId,
    evidence: 'deployed-jar-inspection',
    plugin: definedFields(inspected.plugin),
    deployed: {
      fileName: inspected.deployedFile.fileName,
      sha256: inspected.deployedFile.sha256,
      sizeBytes: inspected.deployedFile.sizeBytes,
      modifiedAt: inspected.deployedFile.modifiedAt,
    },
    source: {
      gitSource: inspected.gitSource,
      buildArtifact: inspected.buildArtifact,
      runtimeIdentity: inspected.runtimeIdentity,
    },
    dependencies: {
      required: [...inspected.plugin.dependencies],
      optional: [...inspected.plugin.softDependencies],
      loadBefore: [...inspected.plugin.loadBefore],
    },
  };
}

function freshnessResult(
  inspected: PluginInspectionResult,
): CurrentTargetFreshness {
  return {
    directoryId: inspected.directoryId,
    state: 'CURRENT',
    scope: 'read-path',
    evidence: 'live-plugin-inspection',
    anchor: {
      fileName: inspected.deployedFile.fileName,
      sha256: inspected.deployedFile.sha256,
      modifiedAt: inspected.deployedFile.modifiedAt,
    },
  };
}

function interfaceResult(
  inspected: PluginInspectionResult,
): CurrentPluginInterface {
  return {
    directoryId: inspected.directoryId,
    evidence: 'deployed-plugin-metadata',
    plugin: interfacePlugin(inspected.plugin),
    deployed: {
      fileName: inspected.deployedFile.fileName,
      sha256: inspected.deployedFile.sha256,
    },
    declaredCommands: [...inspected.plugin.commands],
    declaredPermissions: [...inspected.plugin.permissions],
    caveat: 'metadata-declarations-do-not-prove-runtime-registration',
  };
}

export async function readCurrentPluginDeployment(
  gateway: LiveServerSourceGateway,
  serverId: string,
  directoryId: string,
  fileName: string,
  options: LiveReadOptions = {},
): Promise<LiveSourceResult<CurrentPluginDeployment>> {
  const inspected = await gateway.inspectPlugin(
    serverId,
    directoryId,
    fileName,
    options,
  );
  return mapSuccess(inspected, deploymentResult);
}

export async function readCurrentTargetFreshness(
  gateway: LiveServerSourceGateway,
  serverId: string,
  directoryId: string,
  fileName: string,
  options: LiveReadOptions = {},
): Promise<LiveSourceResult<CurrentTargetFreshness>> {
  const inspected = await gateway.inspectPlugin(
    serverId,
    directoryId,
    fileName,
    options,
  );
  return mapSuccess(inspected, freshnessResult);
}

export async function readCurrentPluginInterface(
  gateway: LiveServerSourceGateway,
  serverId: string,
  directoryId: string,
  fileName: string,
  options: LiveReadOptions = {},
): Promise<LiveSourceResult<CurrentPluginInterface>> {
  const inspected = await gateway.inspectPlugin(
    serverId,
    directoryId,
    fileName,
    options,
  );
  return mapSuccess(inspected, interfaceResult);
}
