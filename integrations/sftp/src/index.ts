/**
 * @enthusia/integration-sftp — SFTP/server file indexer (W09).
 *
 * Read-only knowledge from approved server files. Owns:
 * - allowlisted server roots (config — plugins/, plugin configs, logs);
 * - read-only SFTP access via ssh2 (SFTP subsystem only, never exec/shell);
 * - file metadata (path, size, mtime, sha256);
 * - incremental parsing (hash/size+mtime comparison; unchanged files skipped);
 * - secret deny patterns (HARD DENY, enforced in code on every read path);
 * - periodic reconciliation scheduling (§12.3).
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 24; WORKER-EXECUTION-PLAN.md §12.
 */

export {
  HARD_DENY_RULES,
  SecretDenyError,
  assertAllowedPath,
  compileExtraDenyPatterns,
  denyRuleFor,
  isDeniedPath,
  normalizeForDenyCheck,
  type DenyRule,
} from './deny.js';

export {
  compileConfig,
  findConfiguredRoot,
  liveApprovedFileSchema,
  liveConfigDirectorySchema,
  livePluginDirectorySchema,
  liveSourceSchema,
  sftpIndexerConfigSchema,
  sftpRootSchema,
  sftpServerSchema,
  type CompiledSftpIndexerConfig,
  type LiveApprovedFileConfig,
  type LiveConfigDirectoryConfig,
  type LivePluginDirectoryConfig,
  type LiveSourceConfig,
  type SftpIndexerConfig,
  type SftpRootConfig,
  type SftpServerConfig,
} from './config.js';

export {
  DenyGuardSftpClient,
  SftpError,
  Ssh2SftpClient,
  connectSftp,
  sha256HostKeyFingerprint,
  type SftpClient,
  type SftpCredentials,
  type SftpCredentialsProvider,
  type SshConnectOptions,
  type SftpDirEntry,
  type SftpFileStat,
} from './sftp-client.js';

export {
  SFTP_INDEXER_AUTHORITY,
  SFTP_INDEXER_COMPONENT,
  SftpIndexer,
  buildSftpLocator,
  type ScanCounters,
  type ScanResult,
  type SftpIndexerDeps,
  type SftpIndexerOptions,
} from './indexer.js';

export {
  PARSER_VERSION,
  containsSecretMaterial,
  fingerprintToVersion,
  isProbablyBinary,
  prepareDocumentText,
  type PrepareOutcome,
  type SftpFileFingerprint,
} from './parsers.js';

export {
  SftpReconciler,
  type ReconcileRunSummary,
  type ReconcilerCallbacks,
  type ReconcilerOptions,
  type ReconcilerState,
  type SftpClientFactory,
} from './reconciler.js';

export type {
  ArtifactRegistryPort,
  IndexedChunk,
  RegisterArtifactInput,
  RegisterOutcome,
  RegisterResult,
  RetrievalEnginePort,
  StoredArtifact,
} from './ports.js';


export {
  REDACTED_VALUE,
  containsHighRiskSecretMaterial,
  sanitizeModelVisibleText,
  type SanitizeResult,
  type SanitizedText,
  type SecretContentDenied,
} from './redaction.js';

export {
  parsePluginJar,
  type JarBuildMetadata,
  type ParsedPluginJar,
  type PluginDescriptorKind,
  type PluginMetadata,
} from './jar-metadata.js';

export {
  LiveServerSourceGateway,
  createConfiguredSftpClientFactory,
  type ApprovedFileReadResult,
  type ConfigDiscoveryItem,
  type ConfigDiscoveryResult,
  type DeploymentIdentity,
  type LiveFileIdentity,
  type LiveFileProvenance,
  type LiveReadOptions,
  type LiveServerIdentity,
  type LiveSftpClientFactory,
  type LiveSourceErrorCode,
  type LiveSourceErrorInfo,
  type LiveSourceResult,
  type PluginInspectionResult,
  type PluginListItem,
  type PluginListResult,
  type RuntimeCredentialMaterial,
  type RuntimeCredentialRequest,
  type RuntimeCredentialResolver,
} from './live-source.js';


export {
  LiveServerSourceToolset,
  createLiveServerSourceTools,
} from './live-tools.js';

export {
  readCurrentPluginDeployment,
  readCurrentPluginInterface,
  readCurrentTargetFreshness,
  type CurrentPluginDeployment,
  type CurrentPluginInterface,
  type CurrentTargetFreshness,
} from './current-intelligence.js';

export type {
  Tool,
  ToolCallContext,
  ToolMetadata,
  ToolParameterProperty,
  ToolParametersSchema,
  VerificationTier,
} from './tool-adapter.js';
