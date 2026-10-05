/**
 * Production-capable, model-safe live server source gateway.
 *
 * Public operations accept configured source identifiers, never arbitrary
 * filesystem paths. Transport, parsing, provenance, and public response
 * construction remain separate.
 */

import posixPath from 'node:path/posix';
import {
  type CompiledSftpIndexerConfig,
  type LiveConfigDirectoryConfig,
  type LivePluginDirectoryConfig,
  type SftpServerConfig,
} from './config.js';
import {
  isDeniedPath,
  SecretDenyError,
  type DenyRule,
} from './deny.js';
import { LiveApprovedFileReader } from './live-approved-reader.js';
import { LiveConfigDiscovery } from './live-config-discovery.js';
import {
  fail,
  LiveAbortError,
  LiveBoundaryError,
  LiveTimeoutError,
  mapLiveFailure,
} from './live-errors.js';
import {
  buildArtifactIdentity,
  liveFileIdentity,
  liveProvenance,
  liveServerIdentity,
  runtimePluginIdentity,
} from './live-provenance.js';
import { parsePluginJar } from './jar-metadata.js';
import { extraRulesFor } from './live-path-policy.js';
import {
  connectSftp,
  DenyGuardSftpClient,
  SftpPathEscapeError,
  type SftpClient,
  type SftpCredentials,
} from './sftp-client.js';
import type {
  ApprovedFileReadResult,
  ConfigDiscoveryResult,
  LiveReadOptions,
  LiveServerIdentity,
  LiveSftpClientFactory,
  LiveSourceResult,
  PluginInspectionResult,
  PluginListItem,
  PluginListResult,
  RuntimeCredentialResolver,
} from './live-types.js';

export type {
  ApprovedFileReadResult,
  ConfigDiscoveryItem,
  ConfigDiscoveryResult,
  DeploymentIdentity,
  LiveFileIdentity,
  LiveFileProvenance,
  LiveReadOptions,
  LiveServerIdentity,
  LiveSftpClientFactory,
  LiveSourceErrorCode,
  LiveSourceErrorInfo,
  LiveSourceResult,
  PluginInspectionResult,
  PluginListItem,
  PluginListResult,
  RuntimeCredentialMaterial,
  RuntimeCredentialRequest,
  RuntimeCredentialResolver,
} from './live-types.js';

interface PluginEntryOutcome {
  item?: PluginListItem;
  warning?: string;
}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(new LiveAbortError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const abort = (): void => finish(() => reject(new LiveAbortError()));
    const timer = setTimeout(
      () => finish(() => reject(new LiveTimeoutError())),
      timeoutMs,
    );
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function safeClose(client: SftpClient | undefined): Promise<void> {
  try {
    await client?.close();
  } catch {
    // Close failure is isolated from the caller.
  }
}

function assertJarBasename(fileName: string): void {
  if (fileName.length === 0 || fileName.length > 255) {
    throw new LiveBoundaryError('INVALID_REQUEST', false);
  }
  if (fileName.includes('\0') || fileName.includes('\\')) {
    throw new LiveBoundaryError('INVALID_REQUEST', false);
  }
  if (posixPath.basename(fileName) !== fileName) {
    throw new LiveBoundaryError('INVALID_REQUEST', false);
  }
  if (posixPath.extname(fileName).toLowerCase() !== '.jar') {
    throw new LiveBoundaryError('INVALID_REQUEST', false);
  }
}

function pluginWarning(error: unknown): string | undefined {
  if (error instanceof LiveBoundaryError && error.code === 'OVERSIZE') {
    return 'oversize-plugin-skipped';
  }
  if (error instanceof SecretDenyError || error instanceof SftpPathEscapeError) {
    return 'denied-plugin-skipped';
  }
  return undefined;
}

function makeConnectOptions(
  server: SftpServerConfig,
  credentials: SftpCredentials,
) {
  return {
    serverId: server.id,
    host: server.host,
    port: server.port,
    readyTimeoutMs: server.readyTimeoutMs,
    credentials: () => credentials,
  };
}

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
    const options = makeConnectOptions(server, credentials);
    return server.hostKeySha256 === undefined
      ? connectSftp(options)
      : connectSftp({ ...options, hostKeySha256: server.hostKeySha256 });
  };
}

export class LiveServerSourceGateway {
  private readonly approvedReader: LiveApprovedFileReader;
  private readonly configDiscovery: LiveConfigDiscovery;

  constructor(
    private readonly compiled: CompiledSftpIndexerConfig,
    private readonly makeClient: LiveSftpClientFactory,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.approvedReader = new LiveApprovedFileReader(compiled);
    this.configDiscovery = new LiveConfigDiscovery(compiled);
  }

  listServers(): LiveServerIdentity[] {
    return this.compiled.config.servers
      .filter((server) => server.liveSource !== undefined)
      .map((server) => liveServerIdentity(server, server.id));
  }

  async listPlugins(
    serverId: string,
    directoryId: string,
    options: LiveReadOptions = {},
  ): Promise<LiveSourceResult<PluginListResult>> {
    return this.run(
      serverId,
      options,
      (client, server) => this.listPluginsOnServer(client, server, directoryId),
    );
  }

  async inspectPlugin(
    serverId: string,
    directoryId: string,
    fileName: string,
    options: LiveReadOptions = {},
  ): Promise<LiveSourceResult<PluginInspectionResult>> {
    try {
      assertJarBasename(fileName);
    } catch {
      const observedAt = this.now().toISOString();
      const server = this.serverById(serverId);
      return fail(
        liveServerIdentity(server, serverId),
        observedAt,
        'INVALID_REQUEST',
        false,
      );
    }

    return this.run(
      serverId,
      options,
      (client, server, observedAt) =>
        this.inspectPluginOnServer(client, server, directoryId, fileName, observedAt),
    );
  }

  async discoverConfigs(
    serverId: string,
    directoryId: string,
    options: LiveReadOptions = {},
  ): Promise<LiveSourceResult<ConfigDiscoveryResult>> {
    return this.run(
      serverId,
      options,
      (client, server) => this.discoverConfigsOnServer(client, server, directoryId),
    );
  }

  async readApprovedFile(
    serverId: string,
    sourceId: string,
    options: LiveReadOptions = {},
  ): Promise<LiveSourceResult<ApprovedFileReadResult>> {
    return this.run(
      serverId,
      options,
      (client, server, observedAt) =>
        this.approvedReader.read(client, server, sourceId, observedAt),
    );
  }

  private async listPluginsOnServer(
    client: SftpClient,
    server: SftpServerConfig,
    directoryId: string,
  ): Promise<PluginListResult> {
    const directory = this.pluginDirectory(server, directoryId);
    const extra = extraRulesFor(this.compiled, server, directory.path);
    const guarded = await DenyGuardSftpClient.forRoot(client, directory.path, extra);
    const entries = await guarded.listDir(directory.path);
    const maxResults = server.liveSource?.maxResults ?? 200;
    const plugins: PluginListItem[] = [];
    const warnings: string[] = [];

    for (const entry of entries) {
      if (plugins.length >= maxResults) break;
      const outcome = await this.pluginEntry(
        guarded,
        server,
        directory,
        entry,
        extra,
      );
      if (outcome.item !== undefined) plugins.push(outcome.item);
      if (outcome.warning !== undefined) warnings.push(outcome.warning);
    }
    return {
      directoryId,
      plugins,
      truncated: entries.length > plugins.length && plugins.length >= maxResults,
      warnings,
    };
  }

  private async pluginEntry(
    client: SftpClient,
    server: SftpServerConfig,
    directory: LivePluginDirectoryConfig,
    entry: { path: string; name: string; isDirectory: boolean },
    extra: readonly DenyRule[],
  ): Promise<PluginEntryOutcome> {
    if (entry.isDirectory || posixPath.extname(entry.name).toLowerCase() !== '.jar') return {};
    if (isDeniedPath(entry.path, extra)) return {};

    try {
      const item = await this.pluginIdentity(client, server, directory, entry.path);
      return item === undefined ? {} : { item };
    } catch (error) {
      const warning = pluginWarning(error);
      if (warning === undefined) throw error;
      return { warning };
    }
  }

  private async inspectPluginOnServer(
    client: SftpClient,
    server: SftpServerConfig,
    directoryId: string,
    fileName: string,
    observedAt: string,
  ): Promise<PluginInspectionResult> {
    const directory = this.pluginDirectory(server, directoryId);
    const live = this.liveConfig(server);
    const extra = extraRulesFor(this.compiled, server, directory.path);
    const guarded = await DenyGuardSftpClient.forRoot(client, directory.path, extra);
    const path = posixPath.join(directory.path, fileName);
    const stat = await guarded.stat(path);
    this.assertReadableFile(stat.isFile, stat.size, live.maxJarBytes);

    const sha256 = await guarded.hashFile(path, live.maxJarBytes);
    const bytes = await guarded.readFile(path, live.maxJarBytes);
    const parsed = parsePluginJar(bytes, live.maxMetadataBytes);
    const deployedFile = liveFileIdentity(path, stat, sha256);
    const serverIdentity = liveServerIdentity(server, server.id);

    return {
      directoryId,
      visibility: directory.visibility,
      plugin: parsed.plugin,
      gitSource: parsed.build.gitSourceSha === undefined
        ? null
        : { sha: parsed.build.gitSourceSha, evidence: 'jar-metadata' },
      buildArtifact: buildArtifactIdentity(fileName, sha256, stat.size, parsed.build),
      deployedFile,
      targetServer: serverIdentity,
      runtimeIdentity: runtimePluginIdentity(parsed.plugin, parsed.build),
      provenance: liveProvenance(serverIdentity, deployedFile, observedAt),
    };
  }

  private async discoverConfigsOnServer(
    client: SftpClient,
    server: SftpServerConfig,
    directoryId: string,
  ): Promise<ConfigDiscoveryResult> {
    const directory = this.configDirectory(server, directoryId);
    return this.configDiscovery.discover(client, server, directory);
  }

>,
    observedAt: string,
  ): ApprovedFileReadResult {
    const result: ApprovedFileReadResult = {
      sourceId: source.id,
      kind: source.kind,
      visibility: source.visibility,
      redactedFields: prepared.redactedFields,
      redactionCount: prepared.redactionCount,
      provenance: liveProvenance(
        liveServerIdentity(server, server.id),
        file,
        observedAt,
      ),
    };
    if (source.kind === 'deployment-identity') {
      result.deploymentIdentity = parseDeploymentIdentity(prepared.text);
    } else {
      result.content = prepared.text;
    }
    return result;
  }

  private assertReadableFile(
    isFile: boolean,
    size: number,
    maxBytes: number,
  ): void {
    if (!isFile) throw new LiveBoundaryError('INVALID_REQUEST', false);
    if (size > maxBytes) throw new LiveBoundaryError('OVERSIZE', false);
  }

  private serverById(serverId: string): SftpServerConfig | undefined {
    return this.compiled.config.servers.find((server) => server.id === serverId);
  }

  private liveConfig(server: SftpServerConfig): NonNullable<SftpServerConfig['liveSource']> {
    if (server.liveSource === undefined) {
      throw new LiveBoundaryError('SOURCE_NOT_CONFIGURED', false);
    }
    return server.liveSource;
  }

  private pluginDirectory(
    server: SftpServerConfig,
    directoryId: string,
  ): LivePluginDirectoryConfig {
    const found = server.liveSource?.pluginDirectories.find(
      (source) => source.id === directoryId,
    );
    if (found === undefined) throw new LiveBoundaryError('SOURCE_NOT_CONFIGURED', false);
    return found;
  }

  private configDirectory(
    server: SftpServerConfig,
    directoryId: string,
  ): LiveConfigDirectoryConfig {
    const found = server.liveSource?.configDirectories.find(
      (source) => source.id === directoryId,
    );
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
    const maxJarBytes = this.liveConfig(server).maxJarBytes;
    if (stat.size > maxJarBytes) throw new LiveBoundaryError('OVERSIZE', false);
    const sha256 = await client.hashFile(path, maxJarBytes);
    return {
      directoryId: directory.id,
      visibility: directory.visibility,
      deployedFile: liveFileIdentity(path, stat, sha256),
    };
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
    const serverIdentity = liveServerIdentity(server, serverId);
    if (server === undefined) return fail(serverIdentity, observedAt, 'UNKNOWN_SERVER', false);
    if (server.liveSource === undefined) {
      return fail(serverIdentity, observedAt, 'SOURCE_NOT_CONFIGURED', false);
    }

    const timeoutMs = Math.min(
      options.timeoutMs ?? server.liveSource.operationTimeoutMs,
      server.liveSource.operationTimeoutMs,
    );
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const client = await this.openClient<T>(server, serverIdentity, observedAt, deadline, options);
    if (!client.ok) return client.result;

    return this.runWithClient(
      client.client,
      server,
      serverIdentity,
      observedAt,
      deadline,
      options,
      operation,
    );
  }

  private async openClient<T>(
    server: SftpServerConfig,
    identity: LiveServerIdentity,
    observedAt: string,
    deadline: number,
    options: LiveReadOptions,
  ): Promise<
    | { ok: true; client: SftpClient }
    | { ok: false; result: LiveSourceResult<T> }
  > {
    const pending = Promise.resolve().then(() => this.makeClient(server.id));
    try {
      const client = await withDeadline(pending, this.remaining(deadline), options.signal);
      return { ok: true, client };
    } catch (error) {
      void pending.then((late) => safeClose(late), () => undefined);
      return {
        ok: false,
        result: mapLiveFailure(identity, observedAt, error, true),
      };
    }
  }

  private async runWithClient<T>(
    client: SftpClient,
    server: SftpServerConfig,
    identity: LiveServerIdentity,
    observedAt: string,
    deadline: number,
    options: LiveReadOptions,
    operation: (
      client: SftpClient,
      server: SftpServerConfig,
      observedAt: string,
    ) => Promise<T>,
  ): Promise<LiveSourceResult<T>> {
    try {
      const result = await withDeadline(
        operation(client, server, observedAt),
        this.remaining(deadline),
        options.signal,
      );
      return { ok: true, server: identity, observedAt, result };
    } catch (error) {
      return mapLiveFailure(identity, observedAt, error, false);
    } finally {
      await safeClose(client);
    }
  }

  private remaining(deadline: number): number {
    return Math.max(1, deadline - Date.now());
  }
}
