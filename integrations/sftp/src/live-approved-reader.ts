import {
  findConfiguredRoot,
  type CompiledSftpIndexerConfig,
  type LiveApprovedFileConfig,
  type SftpServerConfig,
} from './config.js';
import { parseDeploymentIdentity } from './deployment-identity.js';
import { LiveBoundaryError } from './live-errors.js';
import { extraRulesFor } from './live-path-policy.js';
import {
  liveFileIdentity,
  liveProvenance,
  liveServerIdentity,
} from './live-provenance.js';
import { prepareDocumentText } from './parsers.js';
import {
  DenyGuardSftpClient,
  type SftpClient,
} from './sftp-client.js';
import type {
  ApprovedFileReadResult,
  LiveFileIdentity,
} from './live-types.js';

type PreparedText = Extract<
  ReturnType<typeof prepareDocumentText>,
  { ok: true }
>;

function requireLive(server: SftpServerConfig): NonNullable<SftpServerConfig['liveSource']> {
  if (server.liveSource === undefined) {
    throw new LiveBoundaryError('SOURCE_NOT_CONFIGURED', false);
  }
  return server.liveSource;
}

function prepareError(reason: string): LiveBoundaryError {
  return new LiveBoundaryError(
    reason === 'secret-content' ? 'SECRET_CONTENT_DENIED' : 'UNSUPPORTED_CONTENT',
    false,
  );
}

export class LiveApprovedFileReader {
  constructor(private readonly compiled: CompiledSftpIndexerConfig) {}

  async read(
    client: SftpClient,
    server: SftpServerConfig,
    sourceId: string,
    observedAt: string,
  ): Promise<ApprovedFileReadResult> {
    const source = this.source(server, sourceId);
    const live = requireLive(server);
    const root = findConfiguredRoot(server, source.path);
    if (root === undefined) throw new LiveBoundaryError('PATH_DENIED', false);

    const extra = extraRulesFor(this.compiled, server, source.path);
    const guarded = await DenyGuardSftpClient.forRoot(client, root.path, extra);
    const stat = await guarded.stat(source.path);
    if (!stat.isFile) throw new LiveBoundaryError('INVALID_REQUEST', false);
    if (stat.size > live.maxConfigBytes) throw new LiveBoundaryError('OVERSIZE', false);

    const sha256 = await guarded.hashFile(source.path, live.maxConfigBytes);
    const bytes = await guarded.readFile(source.path, live.maxConfigBytes);
    const prepared = prepareDocumentText(bytes, live.maxConfigBytes, source.path);
    if (!prepared.ok) throw prepareError(prepared.skippedReason);

    return this.result(
      server,
      source,
      liveFileIdentity(source.path, stat, sha256),
      prepared,
      observedAt,
    );
  }

  private source(
    server: SftpServerConfig,
    sourceId: string,
  ): LiveApprovedFileConfig {
    const found = server.liveSource?.approvedFiles.find(
      (source) => source.id === sourceId,
    );
    if (found === undefined) {
      throw new LiveBoundaryError('SOURCE_NOT_CONFIGURED', false);
    }
    return found;
  }

  private result(
    server: SftpServerConfig,
    source: LiveApprovedFileConfig,
    file: LiveFileIdentity,
    prepared: PreparedText,
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
}
