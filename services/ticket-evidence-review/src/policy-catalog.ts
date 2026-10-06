import { load } from 'js-yaml';
import { z } from 'zod';
import type { EvidenceConcernSeverity } from './types.js';

export const MAX_POLICY_CATALOG_BYTES = 512 * 1024;
export const MAX_POLICY_RULES = 256;
export const MAX_POLICY_EXAMPLES = 8;

export interface CurrentPolicyProvenance {
  sourceId: string;
  fileVersion: string;
  observedAt: string;
  sourceStatus: 'CURRENT';
}

export interface VerifiedPolicyRule {
  id: string;
  family: string;
  label: string;
  severity: number;
  severityBand: EvidenceConcernSeverity;
  examples: string[];
}

export interface VerifiedPolicyCatalog {
  policyVersion: string;
  provenance: CurrentPolicyProvenance;
  rules: VerifiedPolicyRule[];
}

export class PolicyCatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyCatalogValidationError';
  }
}

const boundedId = z.string().trim().min(1).max(96);
const boundedLabel = z.string().trim().min(1).max(160);
const boundedExample = z.string().trim().min(1).max(240);

const reasonSchema = z.object({
  id: boundedId,
  family: boundedId,
  'display-name': boundedLabel,
  severity: z.number().int().min(0).max(100),
  examples: z.array(boundedExample).max(MAX_POLICY_EXAMPLES).optional(),
  reportable: z.boolean().optional(),
}).passthrough();

const policySchema = z.object({
  version: z.string().trim().min(1).max(64),
  defaults: z.object({
    reportable: z.boolean().optional(),
  }).passthrough().optional(),
  reasons: z.array(reasonSchema).max(MAX_POLICY_RULES),
}).passthrough();

export function parseCurrentReasonPolicyCatalog(
  text: string,
  provenance: CurrentPolicyProvenance,
): VerifiedPolicyCatalog {
  validateProvenance(provenance);
  if (Buffer.byteLength(text, 'utf8') > MAX_POLICY_CATALOG_BYTES) {
    throw new PolicyCatalogValidationError(
      'Moderation policy catalog exceeds the configured size bound.',
    );
  }

  let raw: unknown;
  try {
    raw = load(text);
  } catch {
    throw new PolicyCatalogValidationError(
      'Moderation policy catalog is not valid YAML.',
    );
  }

  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    throw new PolicyCatalogValidationError(
      'Moderation policy catalog does not match the expected reason-policy shape.',
    );
  }

  const defaultReportable = parsed.data.defaults?.reportable ?? true;
  const ids = new Set<string>();
  const rules: VerifiedPolicyRule[] = [];
  for (const reason of parsed.data.reasons) {
    if (ids.has(reason.id)) {
      throw new PolicyCatalogValidationError(
        `Moderation policy catalog contains duplicate reason id: ${reason.id}`,
      );
    }
    ids.add(reason.id);
    if ((reason.reportable ?? defaultReportable) !== true) continue;
    rules.push({
      id: reason.id,
      family: reason.family,
      label: reason['display-name'],
      severity: reason.severity,
      severityBand: policySeverityBand(reason.severity),
      examples: [...(reason.examples ?? [])],
    });
  }

  if (rules.length === 0) {
    throw new PolicyCatalogValidationError(
      'Moderation policy catalog contains no reportable reasons.',
    );
  }

  return {
    policyVersion: parsed.data.version,
    provenance: { ...provenance },
    rules,
  };
}

export function policySeverityBand(
  severity: number,
): EvidenceConcernSeverity {
  if (!Number.isFinite(severity) || severity < 0 || severity > 100) {
    throw new PolicyCatalogValidationError(
      'Policy severity must be between 0 and 100.',
    );
  }
  if (severity >= 90) return 'critical';
  if (severity >= 65) return 'high';
  if (severity >= 35) return 'medium';
  return 'low';
}

function validateProvenance(provenance: CurrentPolicyProvenance): void {
  if (provenance.sourceStatus !== 'CURRENT') {
    throw new PolicyCatalogValidationError(
      'Moderation policy catalog must come from a CURRENT source.',
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provenance.sourceId)) {
    throw new PolicyCatalogValidationError(
      'Moderation policy catalog requires a bounded source id.',
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(provenance.fileVersion)) {
    throw new PolicyCatalogValidationError(
      'Moderation policy catalog requires a SHA-256 file version.',
    );
  }
  if (!Number.isFinite(Date.parse(provenance.observedAt))) {
    throw new PolicyCatalogValidationError(
      'Moderation policy catalog requires a valid observation time.',
    );
  }
}
