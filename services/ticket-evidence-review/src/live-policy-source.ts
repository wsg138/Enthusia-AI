import type {
  ApprovedFileReadResult,
  LiveReadOptions,
  LiveServerSourceGateway,
  LiveSourceResult,
} from '@enthusia/integration-sftp';
import {
  PolicyCatalogValidationError,
  parseCurrentReasonPolicyCatalog,
  type VerifiedPolicyCatalog,
} from './policy-catalog.js';

export const ENTHUSIA_STAFF_REASON_POLICY_SOURCE_ID =
  'enthusia-staff-reason-policies';

type ApprovedFileReader = Pick<LiveServerSourceGateway, 'readApprovedFile'>;

export type LivePolicySourceErrorCode =
  | 'source_unavailable'
  | 'source_mismatch'
  | 'source_redacted'
  | 'invalid_policy';

export class LivePolicySourceError extends Error {
  constructor(readonly code: LivePolicySourceErrorCode) {
    super('Current moderation policy is unavailable.');
    this.name = 'LivePolicySourceError';
  }
}

export interface ReadCurrentReasonPolicyInput {
  reader: ApprovedFileReader;
  serverId: string;
  options?: LiveReadOptions;
}

export async function readCurrentReasonPolicyCatalog(
  input: ReadCurrentReasonPolicyInput,
): Promise<VerifiedPolicyCatalog> {
  const output = await input.reader.readApprovedFile(
    input.serverId,
    ENTHUSIA_STAFF_REASON_POLICY_SOURCE_ID,
    input.options ?? {},
  );
  const source = requirePolicySource(output);
  try {
    return parseCurrentReasonPolicyCatalog(source.content, {
      sourceId: source.result.sourceId,
      fileVersion: source.result.provenance.file.version,
      observedAt: source.result.provenance.observedAt,
      sourceStatus: 'CURRENT',
    });
  } catch (error) {
    if (error instanceof PolicyCatalogValidationError) {
      throw new LivePolicySourceError('invalid_policy');
    }
    throw error;
  }
}

interface VerifiedPolicySource {
  result: ApprovedFileReadResult;
  content: string;
}

function requirePolicySource(
  output: LiveSourceResult<ApprovedFileReadResult>,
): VerifiedPolicySource {
  if (!output.ok) {
    throw new LivePolicySourceError('source_unavailable');
  }
  const result = output.result;
  if (
    result.sourceId !== ENTHUSIA_STAFF_REASON_POLICY_SOURCE_ID ||
    result.kind !== 'config' ||
    typeof result.content !== 'string'
  ) {
    throw new LivePolicySourceError('source_mismatch');
  }
  if (result.redactionCount !== 0 || result.redactedFields.length !== 0) {
    throw new LivePolicySourceError('source_redacted');
  }
  return { result, content: result.content };
}
