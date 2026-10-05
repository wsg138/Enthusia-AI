import posixPath from 'node:path/posix';
import type {
  CompiledSftpIndexerConfig,
  LiveConfigDirectoryConfig,
  SftpServerConfig,
} from './config.js';
import {
  isDeniedPath,
  SecretDenyError,
  type DenyRule,
} from './deny.js';
import { LiveBoundaryError } from './live-errors.js';
import { extraRulesFor } from './live-path-policy.js';
import { liveFileIdentity } from './live-provenance.js';
import {
  DenyGuardSftpClient,
  SftpPathEscapeError,
  type SftpClient,
  type SftpDirEntry,
} from './sftp-client.js';
import type {
  ConfigDiscoveryItem,
  ConfigDiscoveryResult,
} from './live-types.js';

interface WalkState {
  client: SftpClient;
  server: SftpServerConfig;
  directory: LiveConfigDirectoryConfig;
  extra: readonly DenyRule[];
  output: ConfigDiscoveryItem[];
  warnings: string[];
  maxResults: number;
}

function requireLive(server: SftpServerConfig): NonNullable<SftpServerConfig['liveSource']> {
  if (server.liveSource === undefined) {
    throw new LiveBoundaryError('SOURCE_NOT_CONFIGURED', false);
  }
  return server.liveSource;
}

function configWarning(error: unknown): string | undefined {
  if (error instanceof LiveBoundaryError && error.code === 'OVERSIZE') {
    return 'oversize-config-skipped';
  }
  if (error instanceof SecretDenyError || error instanceof SftpPathEscapeError) {
    return 'denied-config-skipped';
  }
  return undefined;
}

export class LiveConfigDiscovery {
  constructor(private readonly compiled: CompiledSftpIndexerConfig) {}

  async discover(
    client: SftpClient,
    server: SftpServerConfig,
    directory: LiveConfigDirectoryConfig,
  ): Promise<ConfigDiscoveryResult> {
    const extra = extraRulesFor(this.compiled, server, directory.path);
    const guarded = await DenyGuardSftpClient.forRoot(client, directory.path, extra);
    const maxResults = requireLive(server).maxResults;
    const state: WalkState = {
      client: guarded,
      server,
      directory,
      extra,
      output: [],
      warnings: [],
      maxResults,
    };

    await this.walk(state, directory.path, 0);
    return {
      directoryId: directory.id,
      files: state.output.slice(0, maxResults),
      truncated: state.output.length > maxResults,
      warnings: state.warnings,
    };
  }

  private async walk(
    state: WalkState,
    path: string,
    depth: number,
  ): Promise<void> {
    if (state.output.length > state.maxResults) return;
    const entries = await state.client.listDir(path);
    for (const entry of entries) {
      if (state.output.length > state.maxResults) return;
      if (isDeniedPath(entry.path, state.extra)) continue;
      await this.handleEntry(state, entry, depth);
    }
  }

  private async handleEntry(
    state: WalkState,
    entry: SftpDirEntry,
    depth: number,
  ): Promise<void> {
    if (!entry.isDirectory) {
      await this.addFile(state, entry.path);
      return;
    }
    if (depth >= state.directory.maxDepth) return;
    await this.walk(state, entry.path, depth + 1);
  }

  private extensionAllowed(state: WalkState, path: string): boolean {
    const extension = posixPath.extname(path).toLowerCase();
    return state.directory.includeExtensions.some(
      (allowed) => allowed.toLowerCase() === extension,
    );
  }

  private async addFile(state: WalkState, path: string): Promise<void> {
    if (!this.extensionAllowed(state, path)) return;
    try {
      const item = await this.fileIdentity(state, path);
      if (item !== undefined) state.output.push(item);
    } catch (error) {
      const warning = configWarning(error);
      if (warning === undefined) throw error;
      state.warnings.push(warning);
    }
  }

  private async fileIdentity(
    state: WalkState,
    path: string,
  ): Promise<ConfigDiscoveryItem | undefined> {
    const stat = await state.client.stat(path);
    if (!stat.isFile) return undefined;
    const maxBytes = requireLive(state.server).maxConfigBytes;
    if (stat.size > maxBytes) throw new LiveBoundaryError('OVERSIZE', false);
    const sha256 = await state.client.hashFile(path, maxBytes);
    return {
      directoryId: state.directory.id,
      visibility: state.directory.visibility,
      file: liveFileIdentity(path, stat, sha256),
    };
  }
}
