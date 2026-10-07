import type { Visibility } from '@enthusia/contracts';
import type {
  LiveApprovedFileConfig,
  SftpServerConfig,
} from './config.js';
import type {
  SftpClient,
  SftpCredentials,
} from './sftp-client.js';
import type { PluginMetadata } from './jar-types.js';

export interface LiveServerIdentity {
  id: string;
  displayName: string;
  environment: string;
}

export interface LiveFileIdentity {
  path: string;
  fileName: string;
  sha256: string;
  version: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface LiveFileProvenance {
  source: 'sftp-live';
  targetServer: LiveServerIdentity;
  file: LiveFileIdentity;
  observedAt: string;
  freshness: {
    kind: 'live-sha256';
    version: string;
  };
}

export interface PluginListItem {
  directoryId: string;
  visibility: Visibility;
  deployedFile: LiveFileIdentity;
}

export interface PluginListResult {
  directoryId: string;
  plugins: PluginListItem[];
  truncated: boolean;
  warnings: string[];
}

export interface PluginInspectionResult {
  directoryId: string;
  visibility: Visibility;
  plugin: PluginMetadata;
  gitSource: { sha: string; evidence: 'jar-metadata' } | null;
  buildArtifact: {
    fileName: string;
    sha256: string;
    sizeBytes: number;
    buildVersion?: string;
    buildId?: string;
    buildTimestamp?: string;
  };
  deployedFile: LiveFileIdentity;
  targetServer: LiveServerIdentity;
  runtimeIdentity: {
    pluginVersion?: string;
    buildVersion?: string;
    buildId?: string;
  } | null;
  provenance: LiveFileProvenance;
}

export interface ConfigDiscoveryItem {
  directoryId: string;
  visibility: Visibility;
  file: LiveFileIdentity;
}

export interface ConfigDiscoveryResult {
  directoryId: string;
  files: ConfigDiscoveryItem[];
  truncated: boolean;
  warnings: string[];
}

export interface DeploymentIdentity {
  deploymentId?: string;
  runtimeVersion?: string;
  gitSha?: string;
  buildId?: string;
  deployedAt?: string;
}

export interface ApprovedFileReadResult {
  sourceId: string;
  kind: LiveApprovedFileConfig['kind'];
  visibility: Visibility;
  content?: string;
  redactedFields: string[];
  redactionCount: number;
  deploymentIdentity?: DeploymentIdentity;
  provenance: LiveFileProvenance;
}

export type SafeConfigScalar = string | number | boolean | null;

export interface ApprovedConfigValueResult {
  sourceId: string;
  valueKey: string;
  value: SafeConfigScalar;
  valueType: 'string' | 'number' | 'boolean' | 'null';
  evidence: 'approved-config-scalar';
  file: {
    fileName: string;
    sha256: string;
    version: string;
    modifiedAt: string;
  };
  provenance: {
    file: {
      version: string;
    };
    observedAt: string;
  };
}

export type LiveSourceErrorCode =
  | 'UNKNOWN_SERVER'
  | 'SOURCE_NOT_CONFIGURED'
  | 'INVALID_REQUEST'
  | 'PATH_DENIED'
  | 'OVERSIZE'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'UNREACHABLE'
  | 'SOURCE_UNAVAILABLE'
  | 'SECRET_CONTENT_DENIED'
  | 'UNSUPPORTED_CONTENT';

export interface LiveSourceErrorInfo {
  code: LiveSourceErrorCode;
  message: string;
  retryable: boolean;
}

export type LiveSourceResult<T> =
  | {
      ok: true;
      server: LiveServerIdentity;
      observedAt: string;
      result: T;
    }
  | {
      ok: false;
      server: LiveServerIdentity;
      observedAt: string;
      error: LiveSourceErrorInfo;
    };

export interface LiveReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type LiveSftpClientFactory = (serverId: string) => Promise<SftpClient>;

export interface RuntimeCredentialRequest {
  serverId: string;
  authSource: SftpServerConfig['authSource'];
  authRef: string;
}

export type RuntimeCredentialMaterial = Omit<SftpCredentials, 'username'>;
export type RuntimeCredentialResolver = (
  request: RuntimeCredentialRequest,
) => Promise<RuntimeCredentialMaterial> | RuntimeCredentialMaterial;
