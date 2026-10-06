import type {
  ApprovedFileReadResult,
  LiveServerSourceGateway,
} from '@enthusia/integration-sftp';
import {
  parseCurrentReasonPolicyCatalog,
  type VerifiedPolicyCatalog,
} from './policy-catalog.js';

export class LivePolicyCatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LivePolicyCatalogUnavailableError';
  }
}

export interface LivePolicyCatalogSource {
  serverId: string;
  sourceId: string;
}

export async function loadCurrentPolicyCatalog(
  gateway: Pick<LiveServerSourceGateway, 'readApprovedFile'>,
  source: LivePolicyCatalogSource,
): Promise<VerifiedPolicyCatalog> {
  const output = await gateway.readApprovedFile(
    source.serverId,
    source.sourceId,
  );
  if (!output.ok) {
    throw new LivePolicyCatalogUnavailableError(
      'Current moderation policy source is unavailable.',
    );
  }
  return catalogFromApprovedRead(output.result, source.sourceId);
}

function catalogFromApprovedRead(
  read: ApprovedFileReadResult,
  expectedSourceId: string,
): VerifiedPolicyCatalog {
  if (read.sourceId !== expectedSourceId) {
    throw new LivePolicyCatalogUnavailableError(
      'Current moderation policy source identity did not match the configured source.',
    );
  }
  if (read.redactionCount !== 0 || read.redactedFields.length !== 0) {
    throw new LivePolicyCatalogUnavailableError(
      'Current moderation policy source required redaction and cannot be used as policy authority.',
    );
  }
  if (read.content === undefined) {
    throw new LivePolicyCatalogUnavailableError(
      'Current moderation policy source did not contain readable policy text.',
    );
  }
  return parseCurrentReasonPolicyCatalog(read.content, {
    sourceId: read.sourceId,
    fileVersion: read.provenance.file.version,
    observedAt: read.provenance.observedAt,
    sourceStatus: 'CURRENT',
  });
}
