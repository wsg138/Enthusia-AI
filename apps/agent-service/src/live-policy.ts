import type { LiveServerSourceGateway } from '@enthusia/integration-sftp';
import {
  parseCurrentReasonPolicyCatalog,
  type VerifiedPolicyCatalog,
} from '@enthusia/ticket-evidence-review';

export interface LivePolicySourceConfig {
  serverId: string;
  sourceId: string;
  environment: string;
}

export type ApprovedPolicyReader = Pick<
  LiveServerSourceGateway,
  'readApprovedFile'
>;

export class LivePolicySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LivePolicySourceError';
  }
}

/**
 * Freshly reads the named, allowlisted deployed policy file for each request.
 * There is deliberately no Git/source fallback: failure means policy truth is
 * unavailable and the moderation pipeline must fail closed.
 */
export class LivePolicyCatalogProvider {
  constructor(
    private readonly gateway: ApprovedPolicyReader,
    private readonly config: LivePolicySourceConfig,
  ) {}

  async read(signal?: AbortSignal): Promise<VerifiedPolicyCatalog> {
    const live = await this.gateway.readApprovedFile(
      this.config.serverId,
      this.config.sourceId,
      signal === undefined ? {} : { signal },
    );
    if (!live.ok) {
      throw new LivePolicySourceError(
        `Live moderation policy is unavailable: ${live.error.code}`,
      );
    }
    requireExpectedSource(live.result.sourceId, this.config.sourceId);
    requireExpectedEnvironment(
      live.server.environment,
      this.config.environment,
    );
    requirePolicyContent(live.result);

    return parseCurrentReasonPolicyCatalog(live.result.content, {
      sourceId: live.result.sourceId,
      fileVersion: live.result.provenance.file.version,
      observedAt: live.result.provenance.observedAt,
      sourceStatus: 'CURRENT',
    });
  }
}

function requireExpectedSource(actual: string, expected: string): void {
  if (actual === expected) return;
  throw new LivePolicySourceError(
    'Live moderation policy source identity did not match configuration.',
  );
}

function requireExpectedEnvironment(
  actual: string,
  expected: string,
): void {
  if (actual === expected) return;
  throw new LivePolicySourceError(
    'Live moderation policy target environment did not match configuration.',
  );
}

function requirePolicyContent(
  result: {
    kind: string;
    content?: string;
    redactionCount: number;
  },
): asserts result is {
  kind: string;
  content: string;
  redactionCount: number;
} {
  if (result.kind !== 'config') {
    throw new LivePolicySourceError(
      'Live moderation policy source must be configured as a config file.',
    );
  }
  if (result.redactionCount !== 0) {
    throw new LivePolicySourceError(
      'Live moderation policy was redacted and cannot be treated as authoritative.',
    );
  }
  if (result.content === undefined || result.content.trim().length === 0) {
    throw new LivePolicySourceError(
      'Live moderation policy source returned no content.',
    );
  }
}
