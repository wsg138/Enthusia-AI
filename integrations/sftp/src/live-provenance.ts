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
  if (server === undefined) {
    return {
      id: requestedId,
      displayName: requestedId,
      environment: 'unknown',
    };
  }
  const live = server.liveSource;
  return {
    id: server.id,
    displayName: live?.displayName ?? server.id,
    environment: live?.environment ?? 'unknown',
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

function assignStringField<T extends object>(
  target: T,
  key: keyof T,
  value: string | undefined,
): void {
  if (value !== undefined) target[key] = value as T[keyof T];
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
  assignStringField(result, 'buildVersion', build.buildVersion);
  assignStringField(result, 'buildId', build.buildId);
  assignStringField(result, 'buildTimestamp', build.buildTimestamp);
  return result;
}

export function runtimePluginIdentity(
  plugin: PluginMetadata,
  build: JarBuildMetadata,
): PluginInspectionResult['runtimeIdentity'] {
  const result: NonNullable<PluginInspectionResult['runtimeIdentity']> = {};
  assignStringField(result, 'pluginVersion', plugin.version);
  assignStringField(result, 'buildVersion', build.buildVersion);
  assignStringField(result, 'buildId', build.buildId);
  return Object.keys(result).length === 0 ? null : result;
}
