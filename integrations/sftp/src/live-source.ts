/**
 * Production-capable, model-safe live server source gateway.
 *
 * The public surface accepts stable server/source identifiers, not arbitrary
 * filesystem paths. Every remote operation is root-confined by
 * DenyGuardSftpClient and every connection is read-only SFTP.
 */

import posixPath from 'node:path/posix';
import { Visibility } from '@enthusia/contracts';
import {
  findConfiguredRoot,
  type CompiledSftpIndexerConfig,
  type LiveApprovedFileConfig,
  type LiveConfigDirectoryConfig,
  type LivePluginDirectoryConfig,
  type SftpServerConfig,
} from './config.js';
import {
  isDeniedPath,
  SecretDenyError,
  type DenyRule,
} from './deny.js';
import { parsePluginJar, type JarBuildMetadata, type PluginMetadata } from './jar-metadata.js';
import { prepareDocumentText } from './parsers.js';
import {
  connectSftp,
  DenyGuardSftpClient,
  SftpPathEscapeError,
  type SftpClient,
  type SftpCredentials,
  type SftpFileStat,
} from './sftp-client.js';

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
  /** May reduce, but never increase, the configured operation timeout. */
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

class LiveBoundaryError extends Error {
  constructor(
    readonly code: LiveSourceErrorCode,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'LiveBoundaryError';
  }
}

class LiveTimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'LiveTimeoutError';
  }
}

class LiveAbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'LiveAbortError';
  }
}

function identityFor(server: SftpServerConfig | undefined, requestedId: string): LiveServerIdentity {
  return {
    id: server?.id ?? requestedId,
    displayName: server?.liveSource?.displayName ?? server?.id ?? requestedId,
    environment: server?.liveSource?.environment ?? 'unknown',
  };
}

function safeMessage(code: LiveSourceErrorCode): string {
  switch (code) {
    case 'UNKNOWN_SERVER': return 'server source is not configured';
    case 'SOURCE_NOT_CONFIGURED': return 'requested source is not configured for this server';
    case 'INVALID_REQUEST': return 'request did not match the typed source contract';
    case 'PATH_DENIED': return 'source path was denied by the read-only boundary';
    case 'OVERSIZE': return 'source exceeds the configured read limit';
    case 'TIMEOUT': return 'server source operation timed out';
    case 'ABORTED': return 'server source operation was cancelled';
    case 'UNREACHABLE': return 'server source is unreachable';
    case 'SECRET_CONTENT_DENIED': return 'source content was denied by the secret boundary';
    case 'UNSUPPORTED_CONTENT': return 'source content is not safe text';
    case 'SOURCE_UNAVAILABLE': return 'server source operation failed safely';
  }
}

function fail<T>(
  server: LiveServerIdentity,
  observedAt: string,
  code: LiveSourceErrorCode,
  retryable: boolean,
): LiveSourceResult<T> {
  return {
    ok: false,
    server,
    observedAt,
    error: { code, message: safeMessage(code), retryable },
  };
}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(new LiveAbortError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LiveTimeoutError()), timeoutMs);
    const abort = (): void => reject(new LiveAbortError());
    signal?.addEventListener('abort', abort, { once: true });

    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  });
}

function modifiedIso(stat: SftpFileStat): string {
  return new Date(stat.mtimeMs).toISOString();
}

function fileIdentity(path: string, stat: SftpFileStat, sha256: string): LiveFileIdentity {
  return {
    path,
    fileName: posixPath.basename(path),
    sha256,
    version: 'sha256:' + sha256,
    sizeBytes: stat.size,
    modifiedAt: modifiedIso(stat),
  };
}

function provenance(
  server: LiveServerIdentity,
  file: LiveFileIdentity,
  observedAt: string,
): LiveFileProvenance {
  return {
    source: 'sftp-live',
    targetServer: server,
    file,
    observedAt,
    freshness: { kind: 'live-sha256', version: file.version },
  };
}

function validateJarName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName.length > 255 ||
    !fileName.toLowerCase().endsWith('.jar') ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    fileName === '.' ||
    fileName === '..'
  ) {
    throw new LiveBoundaryError('INVALID_REQUEST', false);
  }
}

function extraRulesFor(
  compiled: CompiledSftpIndexerConfig,
  server: SftpServerConfig,
  path: string,
): readonly DenyRule[] {
  const root = findConfiguredRoot(server, path);
  if (root === undefined) throw new LiveBoundaryError('PATH_DENIED', false);
  return compiled.extraDenyByRoot.get(server.id + ':' + root.path) ?? [];
}

function copyBuildMetadata(
  target: PluginInspectionResult['buildArtifact'],
  build: JarBuildMetadata,
): void {
  if (build.buildVersion !== undefined) target.buildVersion = build.buildVersion;
  if (build.buildId !== undefined) target.buildId = build.buildId;
  if (build.buildTimestamp !== undefined) target.buildTimestamp = build.buildTimestamp;
}

function runtimeIdentity(
  plugin: PluginMetadata,
  build: JarBuildMetadata,
): PluginInspectionResult['runtimeIdentity'] {
  if (
    plugin.version === undefined &&
    build.buildVersion === undefined &&
    build.buildId === undefined
  ) {
    return null;
  }
  const identity: NonNullable<PluginInspectionResult['runtimeIdentity']> = {};
  if (plugin.version !== undefined) identity.pluginVersion = plugin.version;
  if (build.buildVersion !== undefined) identity.buildVersion = build.buildVersion;
  if (build.buildId !== undefined) identity.buildId = build.buildId;
  return identity;
}

function parseDeploymentIdentity(text: string): DeploymentIdentity {
  const values = new Map<string, string>();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' || typeof value === 'number') {
        values.set(key.toLowerCase().replace(/[^a-z0-9]/g, ''), String(value));
      }
    }
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z0-9_.-]+)\s*[:=]\s*(.*?)\s*$/.exec(line);
      if (match?.[1] !== undefined) {
        values.set(match[1].toLowerCase().replace(/[^a-z0-9]/g, ''), match[2] ?? '');
      }
    }
  }

  const result: DeploymentIdentity = {};
  const take = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const value = values.get(key);
      if (value !== undefined && value.length > 0 && value !== '[REDACTED]') return value;
    }
    return undefined;
  };
  const deploymentId = take(['deploymentid', 'releaseid']);
  const runtimeVersion = take(['runtimeversion', 'version', 'releaseversion']);
  const git = take(['gitsha', 'gitcommit', 'commitsha', 'revision']);
  const buildId = take(['buildid', 'buildnumber']);
  const deployedAt = take(['deployedat', 'deploymenttime', 'releasedat']);
  if (deploymentId !== undefined) result.deploymentId = deploymentId;
  if (runtimeVersion !== undefined) result.runtimeVersion = runtimeVersion;
  if (git !== undefined && /^[0-9a-f]{7,64}$/i.test(git)) result.gitSha = git.toLowerCase();
  if (buildId !== undefined) result.buildId = buildId;
  if (deployedAt !== undefined) result.deployedAt = deployedAt;
  return result;
}

async function safeClose(client: SftpClient | undefined): Promise<void> {
  try {
    await client?.close();
  } catch {
    // Close failure is intentionally isolated from callers.
  }
}

/**
 * Build the production client factory without ever placing credential values
 * in configuration or model-visible results.
 */
export function createConfiguredSftpClientFactory(
  compiled: CompiledSftpIndexerConfig,
  resolveCredentials: RuntimeCredentialResolver,
): LiveSftpClientFactory {
  return async (serverId: string): Promise<SftpClient> => {
    const server = compiled.config.servers.find((candidate) => candidate.id === serverId);
    if (server === undefined) throw new Error('unknown configured server');
    if (server.liveSource !== undefined && server.hostKeySha256 === undefined) {
      throw new Error('live server is missing host-key pin');
    }
    const material = await resolveCredentials({
      serverId: server.id,
      authSource: server.authSource,
      authRef: server.authRef,
    });
    const credentials: SftpCredentials = { ...material, username: server.username };
    const options = {
      serverId: server.id,
      host: server.host,
      port: server.port,
      readyTimeoutMs: server.readyTimeoutMs,
      credentials: () => credentials,
    };
    if (server.hostKeySha256 === undefined) return connectSftp(options);
    return connectSftp({ ...options, hostKeySha256: server.hostKeySha256 });
  };
}

export class LiveServerSourceGateway {
  constructor(
    private readonly compiled: CompiledSftpIndexerConfig,
    private readonly makeClient: LiveSftpClientFactory,
    private readonly now: () => Date = () => new Date(),
  ) {}

  listServers(): LiveServerIdentity[] {
    return this.compiled.config.servers
      .filter((server) => server.liveSource !== undefined)
      .map((server) => identityFor(server, server.id));
  }

  async listPlugins(
    serverId: string,
    directoryId: string,
    options: LiveReadOptions = {},
  ): Promise<LiveSourceResult<PluginListResult>> {
    return this.run(serverId, options, async (client, server) => {
      const directory = this.pluginDirectory(server, directoryId);
      const extra = extraRulesFor(this.compiled, server, directory.path);
      const guarded = await DenyGuardSftpClient.forRoot(client, directory.path, extra);
      const entries = await guarded.listDir(directory.path);
      const maxResults = server.liveSource?.maxResults ?? 200;
      const plugins: PluginListItem[] = [];
      const warnings: string[] = [];

      for (const entry of entries) {
        if (plugins.length >= maxResults) break;
        if (entry.isDirectory || !entry.name.toLowerCase().endsWith('.jar')) continue;
        if (isDeniedPath(entry.path, extra)) continue;
        try {
          const item = await this.pluginIdentity(guarded, server, directory, entry.path);
          if (item !== undefined) plugins.push(item);
        } catch (error) {
          if (error instanceof LiveBoundaryError && error.code === 'OVERSIZE') {
            warnings.push('oversize-plugin-skipped');
            continue;
          }
          if (error instanceof SecretDenyError || error instanceof SftpPathEscapeError) {
            warnings.push('denied-plugin-skipped');
            continue;
          }
          throw error;
        }
      }
      return {
        directoryId,
        plugins,
        truncated: plugins.length >= maxResults && entries.length > plugins.length,
        warnings,
      };
    });
  }

  async inspectPlugin(
    serverId: string,
    directoryId: string,
    fileName: string,
    options: LiveReadOptions = {},
  ): Promise<LiveSourceResult<PluginInspectionResult>> {
    try {
      validateJarName(fileName);
    } catch {
      const server = this.serverById(serverId);
      const observedAt = this.now().toISOString();
      return fail(identityFor(server, serverId), observedAt, 'INVALID_REQUEST', false);
    }

    return this.run(serverId, options, async (client, server, observedAt) => {
      const directory = this.pluginDirectory(server, directoryId);
      const extra = extraRulesFor(this.compiled, server, directory.path);
      const guarded = await DenyGuardSftpClient.forRoot(client, directory.path, extra);
      const path = posixPath.join(directory.path, fileName);
      const stat = await guarded.stat(path);
      const live = server.liveSource;
      if (live === undefined) throw new LiveBoundaryError('SOURCE_NOT_CONFIGURED', false);
      if (!stat.isFile) throw new LiveBoundaryError('INVALID_REQUEST', false);
      if (stat.size > live.maxJarBytes) throw new LiveBoundaryError('OVERSIZE', false);

      const sha256 = await guarded.hashFile(path, live.maxJarBytes);
      const bytes = await guarded.readFile(path, live.maxJarBytes);
      const parsed = parsePluginJar(bytes, live.maxMetadataBytes);
      const deployedFile = fileIdentity(path, stat, sha256);
      const serverIdentity = identityFor(server, server.id);
      const buildArtifact: PluginInspectionResult['buildArtifact'] = {
        fileName,
        sha256,
        sizeBytes: stat.size,
      };
      copyBuildMetadata(buildArtifact, parsed.build);

      return {
        directoryId,
        visibility: directory.visibility,
        plugin: parsed.plugin,
        gitSource: parsed.build.gitSourceSha === undefined
          ? null
          : { sha: parsed.build.gitSourceSha, evidence: 'jar-metadata' },
        buildArtifact,
        deployedFile,
        targetServer: serverIdentity,
        runtimeIdentity: runtimeIdentity(parsed.plugin, parsed.build),
        provenance: provenance(serverIdentity, deployedFile, observedAt),
      };
    });
  }

  async discoverConfigs(
    serverId: string,
    directoryId: string,
    options: LiveReadOptions = {},
  ): Promise<LiveSourceResult<ConfigDiscoveryResult>> {
    return this.run(serverId, options, async (client, server) => {
      const directory = this.configDirectory(server, directoryId);
      const extra = extraRulesFor(this.compiled, server, directory.path);
      const guarded = await DenyGuardSftpClient.forRoot(client, directory.path, extra);
      const files: ConfigDiscoveryItem[] = [];
      const warnings: string[] = [];
      await this.walkConfigs(
        guarded,
        server,
        directory,
        directory.path,
        0,
        files,
        warnings,
        extra,
      );
      const maxResults = server.liveSource?.maxResults ?? 200;
      return {
        directoryId,
        files: files.slice(0, maxResults),
        truncated: files.length > maxResults,
        warnings,
      };
    });
  }

  async readApprovedFile(
    serverId: string,
    sourceId: string,
    options: LiveReadOptions = {},
  ): Promise<LiveSourceResult<ApprovedFileReadResult>> {
    return this.run(serverId, options, async (client, server, observedAt) => {
      const source = this.approvedFile(server, sourceId);
      const extra = extraRulesFor(this.compiled, server, source.path);
      const root = findConfiguredRoot(server, source.path);
      if (root === undefined) throw new LiveBoundaryError('PATH_DENIED', false);
      const guarded = await DenyGuardSftpClient.forRoot(client, root.path, extra);
      const stat = await guarded.stat(source.path);
      const maxBytes = server.liveSource?.maxConfigBytes ?? 1024 * 1024;
      if (!stat.isFile) throw new LiveBoundaryError('INVALID_REQUEST', false);
      if (stat.size > maxBytes) throw new LiveBoundaryError('OVERSIZE', false);

      const sha256 = await guarded.hashFile(source.path, maxBytes);
      const bytes = await guarded.readFile(source.path, maxBytes);
      const prepared = prepareDocumentText(bytes, maxBytes, source.path);
      if (!prepared.ok) {
        const code = prepared.skippedReason === 'secret-content'
          ? 'SECRET_CONTENT_DENIED'
          : 'UNSUPPORTED_CONTENT';
        throw new LiveBoundaryError(code, false);
      }

      const file = fileIdentity(source.path, stat, sha256);
      const result: ApprovedFileReadResult = {
        sourceId,
        kind: source.kind,
        visibility: source.visibility,
        redactedFields: prepared.redactedFields,
        redactionCount: prepared.redactionCount,
        provenance: provenance(identityFor(server, server.id), file, observedAt),
      };
      if (source.kind === 'deployment-identity') {
        result.deploymentIdentity = parseDeploymentIdentity(prepared.text);
      } else {
        result.content = prepared.text;
      }
      return result;
    });
  }

  private serverById(serverId: string): SftpServerConfig | undefined {
    return this.compiled.config.servers.find((server) => server.id === serverId);
  }

  private pluginDirectory(
    server: SftpServerConfig,
    directoryId: string,
  ): LivePluginDirectoryConfig {
    const found = server.liveSource?.pluginDirectories.find((source) => source.id === directoryId);
    if (found === undefined) throw new LiveBoundaryError('SOURCE_NOT_CONFIGURED', false);
    return found;
  }

  private configDirectory(
    server: SftpServerConfig,
    directoryId: string,
  ): LiveConfigDirectoryConfig {
    const found = server.liveSource?.configDirectories.find((source) => source.id === directoryId);
    if (found === undefined) throw new LiveBoundaryError('SOURCE_NOT_CONFIGURED', false);
    return found;
  }

  private approvedFile(server: SftpServerConfig, sourceId: string): LiveApprovedFileConfig {
    const found = server.liveSource?.approvedFiles.find((source) => source.id === sourceId);
    if (found === undefined) throw new LiveBoundaryError('SOURCE_NOT_CONFIGURED', false);
    return found;
  }

  private async pluginIdentity(
    client: SftpClient,
    server: SftpServerConfig,
    directory: LivePluginDirectoryConfig,
    path: string,
  ): Promise<PluginListItem | undefined> {
    const stat = await client.stat(path);
    if (!stat.isFile) return undefined;
    const maxJarBytes = server.liveSource?.maxJarBytes ?? 64 * 1024 * 1024;
    if (stat.size > maxJarBytes) throw new LiveBoundaryError('OVERSIZE', false);
    const sha256 = await client.hashFile(path, maxJarBytes);
    return {
      directoryId: directory.id,
      visibility: directory.visibility,
      deployedFile: fileIdentity(path, stat, sha256),
    };
  }

  private async walkConfigs(
    client: SftpClient,
    server: SftpServerConfig,
    directory: LiveConfigDirectoryConfig,
    path: string,
    depth: number,
    output: ConfigDiscoveryItem[],
    warnings: string[],
    extra: readonly DenyRule[],
  ): Promise<void> {
    const hardMax = server.liveSource?.maxResults ?? 200;
    if (output.length > hardMax) return;
    const entries = await client.listDir(path);
    for (const entry of entries) {
      if (output.length > hardMax) return;
      if (isDeniedPath(entry.path, extra)) continue;
      if (entry.isDirectory) {
        if (depth < directory.maxDepth) {
          await this.walkConfigs(
            client,
            server,
            directory,
            entry.path,
            depth + 1,
            output,
            warnings,
            extra,
          );
        }
        continue;
      }
      await this.addConfigIdentity(
        client,
        server,
        directory,
        entry.path,
        output,
        warnings,
      );
    }
  }

  private async addConfigIdentity(
    client: SftpClient,
    server: SftpServerConfig,
    directory: LiveConfigDirectoryConfig,
    path: string,
    output: ConfigDiscoveryItem[],
    warnings: string[],
  ): Promise<void> {
    const extension = posixPath.extname(path).toLowerCase();
    if (!directory.includeExtensions.map((item) => item.toLowerCase()).includes(extension)) return;
    try {
      const stat = await client.stat(path);
      if (!stat.isFile) return;
      const maxBytes = server.liveSource?.maxConfigBytes ?? 1024 * 1024;
      if (stat.size > maxBytes) {
        warnings.push('oversize-config-skipped');
        return;
      }
      const sha256 = await client.hashFile(path, maxBytes);
      output.push({
        directoryId: directory.id,
        visibility: directory.visibility,
        file: fileIdentity(path, stat, sha256),
      });
    } catch (error) {
      if (error instanceof SecretDenyError || error instanceof SftpPathEscapeError) {
        warnings.push('denied-config-skipped');
        return;
      }
      throw error;
    }
  }

  private async run<T>(
    serverId: string,
    options: LiveReadOptions,
    operation: (
      client: SftpClient,
      server: SftpServerConfig,
      observedAt: string,
    ) => Promise<T>,
  ): Promise<LiveSourceResult<T>> {
    const observedAt = this.now().toISOString();
    const server = this.serverById(serverId);
    const serverIdentity = identityFor(server, serverId);
    if (server === undefined) return fail(serverIdentity, observedAt, 'UNKNOWN_SERVER', false);
    if (server.liveSource === undefined) {
      return fail(serverIdentity, observedAt, 'SOURCE_NOT_CONFIGURED', false);
    }

    const timeoutMs = Math.min(
      options.timeoutMs ?? server.liveSource.operationTimeoutMs,
      server.liveSource.operationTimeoutMs,
    );
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let client: SftpClient | undefined;
    const pendingClient = this.makeClient(server.id);

    try {
      client = await withDeadline(pendingClient, this.remaining(deadline), options.signal);
    } catch (error) {
      void pendingClient.then((late) => safeClose(late), () => undefined);
      return this.mapFailure(serverIdentity, observedAt, error, true);
    }

    try {
      const value = await withDeadline(
        operation(client, server, observedAt),
        this.remaining(deadline),
        options.signal,
      );
      return { ok: true, server: serverIdentity, observedAt, result: value };
    } catch (error) {
      return this.mapFailure(serverIdentity, observedAt, error, false);
    } finally {
      await safeClose(client);
    }
  }

  private remaining(deadline: number): number {
    return Math.max(1, deadline - Date.now());
  }

  private mapFailure<T>(
    server: LiveServerIdentity,
    observedAt: string,
    error: unknown,
    connecting: boolean,
  ): LiveSourceResult<T> {
    if (error instanceof LiveTimeoutError) return fail(server, observedAt, 'TIMEOUT', true);
    if (error instanceof LiveAbortError) return fail(server, observedAt, 'ABORTED', false);
    if (error instanceof SecretDenyError || error instanceof SftpPathEscapeError) {
      return fail(server, observedAt, 'PATH_DENIED', false);
    }
    if (error instanceof LiveBoundaryError) {
      return fail(server, observedAt, error.code, error.retryable);
    }
    if (connecting) return fail(server, observedAt, 'UNREACHABLE', true);
    return fail(server, observedAt, 'SOURCE_UNAVAILABLE', true);
  }
}
