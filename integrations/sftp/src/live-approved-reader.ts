import { JSON_SCHEMA, load } from 'js-yaml';
import {
  findConfiguredRoot,
  type CompiledSftpIndexerConfig,
  type LiveApprovedFileConfig,
  type LiveSafeConfigValueConfig,
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
import { REDACTED_VALUE } from './redaction.js';
import {
  DenyGuardSftpClient,
  type SftpClient,
} from './sftp-client.js';
import type {
  ApprovedConfigValueResult,
  ApprovedFileReadResult,
  LiveFileIdentity,
  SafeConfigScalar,
} from './live-types.js';

type PreparedText = Extract<
  ReturnType<typeof prepareDocumentText>,
  { ok: true }
>;

const MAX_SAFE_SCALAR_TEXT = 2_000;

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

  async readConfigValue(
    client: SftpClient,
    server: SftpServerConfig,
    sourceId: string,
    valueKey: string,
    observedAt: string,
  ): Promise<ApprovedConfigValueResult> {
    const source = this.source(server, sourceId);
    const configured = this.safeValue(source, valueKey);
    const approved = await this.read(client, server, sourceId, observedAt);
    if (approved.content === undefined) {
      throw new LiveBoundaryError('UNSUPPORTED_CONTENT', false);
    }

    const value = extractSafeScalar(
      approved.content,
      source.format,
      configured.path,
    );
    rejectRedactedScalar(value);

    const file = approved.provenance.file;
    return {
      sourceId,
      valueKey,
      value,
      valueType: scalarType(value),
      evidence: 'approved-config-scalar',
      file: {
        fileName: file.fileName,
        sha256: file.sha256,
        version: file.version,
        modifiedAt: file.modifiedAt,
      },
      provenance: {
        file: { version: file.version },
        observedAt,
      },
    };
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

  private safeValue(
    source: LiveApprovedFileConfig,
    valueKey: string,
  ): LiveSafeConfigValueConfig {
    const found = source.safeValues.find((value) => value.id === valueKey);
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

function extractSafeScalar(
  content: string,
  format: LiveApprovedFileConfig['format'],
  path: readonly string[],
): SafeConfigScalar {
  const raw = format === 'properties'
    ? parseProperties(content)
    : parseStructured(content, format);
  const value = lookupOwnPath(raw, path);
  return requireScalar(value);
}

function parseStructured(
  content: string,
  format: LiveApprovedFileConfig['format'],
): unknown {
  try {
    if (format === 'json') return JSON.parse(content) as unknown;
    if (format === 'yaml') return load(content, { schema: JSON_SCHEMA });
  } catch {
    throw new LiveBoundaryError('UNSUPPORTED_CONTENT', false);
  }
  throw new LiveBoundaryError('UNSUPPORTED_CONTENT', false);
}

function parseProperties(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([^#!\s][^:=]*?)\s*[:=]\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1]?.trim();
    if (key === undefined || key.length === 0) continue;
    result[key] = match[2] ?? '';
  }
  return result;
}

function lookupOwnPath(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const segment of path) {
    const record = ownRecord(value);
    if (
      record === undefined ||
      !Object.prototype.hasOwnProperty.call(record, segment)
    ) {
      throw new LiveBoundaryError('SOURCE_UNAVAILABLE', false);
    }
    value = record[segment];
  }
  return value;
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function requireScalar(value: unknown): SafeConfigScalar {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= MAX_SAFE_SCALAR_TEXT) {
    return value;
  }
  throw new LiveBoundaryError('UNSUPPORTED_CONTENT', false);
}

function rejectRedactedScalar(value: SafeConfigScalar): void {
  if (typeof value === 'string' && value.includes(REDACTED_VALUE)) {
    throw new LiveBoundaryError('SECRET_CONTENT_DENIED', false);
  }
}

function scalarType(
  value: SafeConfigScalar,
): ApprovedConfigValueResult['valueType'] {
  return value === null ? 'null' : typeof value;
}
