/**
 * @enthusia/openai-gateway — escalation packet types and validation (W13).
 *
 * The InvestigationPacket is built by W12 (@enthusia/agent-core, packet.ts).
 * W12 and W13 live in different packages, so this file carries a structural
 * mirror of W12's interface — never import W12's implementation, and keep
 * the shape in sync with W12's builder. If the two disagree, W12's builder
 * and MASTER-SPECIFICATION.md §22.2 are authoritative.
 *
 * Spec: MASTER-SPECIFICATION.md §22.2 (escalation packet).
 */
import { Visibility } from '@enthusia/contracts';

/** One evidence item as carried in the packet (W12's PacketEvidence). */
export interface PacketEvidence {
  id: string;
  claim: string;
  value: string;
  toolName: string;
  source: string;
  visibility: Visibility;
  verificationTier: string;
  version?: string;
  observedTime?: string;
  excerpt?: string;
}

/** Authorization context for the escalation (W12). */
export interface PacketAuthorization {
  actorId: string;
  actorKind: string;
  visibilityCeiling: Visibility;
}

/**
 * Structured investigation packet (§22.2). Built by W12; consumed here.
 * SECRET_DENY evidence is never included (W12 redacts; see format step
 * which also drops it defensively, §17.6).
 */
export interface InvestigationPacket {
  /** Packet reference, e.g. `packet:<traceId>`. */
  packetRef: string;
  traceId: string;
  /** The user's original question. */
  userQuestion: string;
  /** What the user is trying to achieve (intent summary). */
  goal: string;
  requestClass: string;
  /** Repositories implicated by the evidence (derived from sources). */
  relevantRepositories: string[];
  /** Files implicated by the evidence (derived from sources). */
  relevantFiles: string[];
  /** Source → current version fingerprint (SHA/hash), from tool freshness. */
  currentShas: Record<string, string>;
  /** Sanitized tool evidence (anything above the request ceiling is excluded upstream). */
  toolEvidence: PacketEvidence[];
  /** Investigation/tool trace notes carried from W12. */
  logs: string[];
  /** What the local investigation tried, in order. */
  attemptedDiagnosis: string[];
  /** Questions the local investigation could not resolve. */
  unresolvedQuestions: string[];
  /** Constraints the stronger model must respect. */
  constraints: string[];
  /** Authorization context for the escalation. */
  authorization: PacketAuthorization;
  /** What the stronger model should produce. */
  expectedOutput: string;
  /** Number of evidence items redacted for visibility. */
  redactedEvidenceCount: number;
}

/** One structural problem found in a packet. */
export interface PacketValidationIssue {
  field: string;
  message: string;
}

/** Thrown when a packet fails §22.2 validation. Carries every issue found. */
export class InvalidPacketError extends Error {
  readonly issues: PacketValidationIssue[];

  constructor(issues: PacketValidationIssue[]) {
    super(
      `Invalid escalation packet: ${issues
        .map((i) => `${i.field}: ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'InvalidPacketError';
    this.issues = issues;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function isValidVisibility(value: unknown): value is Visibility {
  return (
    typeof value === 'string' &&
    (Object.values(Visibility) as string[]).includes(value)
  );
}

function isPacketEvidence(value: unknown): value is PacketEvidence {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    isNonEmptyString(item['id']) &&
    typeof item['claim'] === 'string' &&
    typeof item['value'] === 'string' &&
    typeof item['toolName'] === 'string' &&
    typeof item['source'] === 'string' &&
    isValidVisibility(item['visibility']) &&
    typeof item['verificationTier'] === 'string'
  );
}

/**
 * Validate the §22.2 required structure. Returns every issue found;
 * empty means the packet is well-formed. Never sends anything anywhere.
 */
export function validateInvestigationPacket(
  packet: unknown,
): PacketValidationIssue[] {
  const issues: PacketValidationIssue[] = [];
  const fail = (field: string, message: string): void => {
    issues.push({ field, message });
  };

  if (typeof packet !== 'object' || packet === null) {
    fail('(root)', 'packet must be an object');
    return issues;
  }
  const p = packet as Record<string, unknown>;

  if (!isNonEmptyString(p['packetRef'])) {
    fail('packetRef', 'must be a non-empty string');
  }
  if (!isNonEmptyString(p['traceId'])) {
    fail('traceId', 'must be a non-empty string');
  }
  if (!isNonEmptyString(p['userQuestion'])) {
    fail('userQuestion', 'must be a non-empty string (§22.2: user question)');
  }
  if (!isNonEmptyString(p['goal'])) {
    fail('goal', 'must be a non-empty string (§22.2: goal)');
  }
  if (!isNonEmptyString(p['requestClass'])) {
    fail('requestClass', 'must be a non-empty string');
  }
  if (!isStringArray(p['relevantRepositories'])) {
    fail('relevantRepositories', 'must be an array of strings (§22.2)');
  }
  if (!isStringArray(p['relevantFiles'])) {
    fail('relevantFiles', 'must be an array of strings (§22.2)');
  }
  if (!isStringRecord(p['currentShas'])) {
    fail('currentShas', 'must be a string→string map (§22.2: current SHAs)');
  }
  if (!Array.isArray(p['toolEvidence'])) {
    fail('toolEvidence', 'must be an array (§22.2: tool evidence)');
  } else if (!p['toolEvidence'].every(isPacketEvidence)) {
    fail('toolEvidence', 'every evidence item must have id/claim/value/toolName/source/visibility/verificationTier');
  }
  if (!isStringArray(p['logs'])) {
    fail('logs', 'must be an array of strings (§22.2: logs)');
  }
  if (!isStringArray(p['attemptedDiagnosis'])) {
    fail('attemptedDiagnosis', 'must be an array of strings (§22.2)');
  }
  if (!isStringArray(p['unresolvedQuestions'])) {
    fail('unresolvedQuestions', 'must be an array of strings (§22.2)');
  }
  if (!isStringArray(p['constraints'])) {
    fail('constraints', 'must be an array of strings (§22.2)');
  }
  if (!isNonEmptyString(p['expectedOutput'])) {
    fail('expectedOutput', 'must be a non-empty string (§22.2: expected output)');
  }
  if (typeof p['redactedEvidenceCount'] !== 'number') {
    fail('redactedEvidenceCount', 'must be a number');
  }

  const auth = p['authorization'];
  if (typeof auth !== 'object' || auth === null) {
    fail('authorization', 'must be an object (§22.2: authorization)');
  } else {
    const a = auth as Record<string, unknown>;
    if (!isNonEmptyString(a['actorId'])) {
      fail('authorization.actorId', 'must be a non-empty string');
    }
    if (!isNonEmptyString(a['actorKind'])) {
      fail('authorization.actorKind', 'must be a non-empty string');
    }
    if (!isValidVisibility(a['visibilityCeiling'])) {
      fail('authorization.visibilityCeiling', 'must be a valid Visibility');
    }
  }

  return issues;
}

/** Validate and throw InvalidPacketError when the packet is malformed. */
export function assertValidInvestigationPacket(
  packet: unknown,
): asserts packet is InvestigationPacket {
  const issues = validateInvestigationPacket(packet);
  if (issues.length > 0) {
    throw new InvalidPacketError(issues);
  }
}
