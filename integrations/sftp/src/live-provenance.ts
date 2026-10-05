import posixPath from 'node:path/posix';
import type { SftpServerConfig } from './config.js';
import type {
  JarBuildMetadata,
  PluginMetadata,
} from './jar-types.js';
import type { SftpFileStat } from './sftp-client.js';
import type {
  LiveFileIdentity,
  LiveFileProvenance,
  LiveServerIdentity,
  PluginInspectionResult,
} from './live-types.js';

export function liveServerIdentity(
  server: SftpServerConfig | undefined,
  requestedId: string,
): LiveServerIdentity {
  return {
    id: server?.id ?? requestedId,
    displayName: server?.liveSource?.displayName ?? server?.id ?? requestedId,
    environment: server?.liveSource?.environment ?? 'unknown',
  };
}

export function liveFileIdentity(
  path: string,
  stat: SftpFileStat,
  sha256: string,
): LiveFileIdentity {
  return {
    path,
    fileName: posixPath.basename(path),
    sha256,
    version: 'sha256:' + sha256,
    sizeBytes: stat.size,
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
  };
}

export function liveProvenance(
  server: LiveServerIdentity,
  file: LiveFileIdentity,
  observedAt: string,
): LiveFileProvenance {
  return {
    source: 'sftp-live',
    targetServer: server,
    file,
    observedAt,
    freshness: {
      kind: 'live-sha256',
      version: file.version,
    },
  };
}

export function buildArtifactIdentity(
  fileName: string,
  sha256: string,
  sizeBytes: number,
  build: JarBuildMetadata,
): PluginInspectionResult['buildArtifact'] {
  const result: PluginInspectionResult['buildArtifact'] = {
    fileName,
    sha256,
    sizeBytes,
  };
  if (build.buildVersion !== undefined) result.buildVersion = build.buildVersion;
  if (build.buildId !== undefined) result.buildId = build.buildId;
  if (build.buildTimestamp !== undefined) result.buildTimestamp = build.buildTimestamp;
  return result;
}

export function runtimePluginIdentity(
  plugin: PluginMetadata,
  build: JarBuildMetadata,
): PluginInspectionResult['runtimeIdentity'] {
  const result: NonNullable<PluginInspectionResult['runtimeIdentity']> = {};
  if (plugin.version !== undefined) result.pluginVersion = plugin.version;
  if (build.buildVersion !== undefined) result.buildVersion = build.buildVersion;
  if (build.buildId !== undefined) result.buildId = build.buildId;
  return Object.keys(result).length === 0 ? null : result;
}
