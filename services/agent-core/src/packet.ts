/**
 * @enthusia/agent-core — investigation packet for escalation (W12 → W13).
 *
 * Spec §22.2: never send a bare "fix this". The escalation packet carries
 * structured context: user question, goal, relevant repositories, relevant
 * files, current SHAs, logs, tool evidence, attempted diagnosis, unresolved
 * questions, constraints, authorization, expected output.
 *
 * W13 (OpenAI escalation) consumes this packet and submits it to the
 * stronger model. Visibility: SECRET_DENY evidence is never included
 * (§17.6); the packet records what was redacted.
 */
import { canDisclose, SourceStatus, Visibility } from '@enthusia/contracts';
import type {
  ClaimAssessment,
  EvidenceItem,
  ExecutedToolCall,
  IntentClassification,
  ResolvedChatRequest,
} from './types.js';
import type { InvestigationOutcome } from './investigation.js';

/** Structured investigation packet (§22.2). Consumed by W13. */
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
  /** Sanitized tool evidence (anything above the request ceiling is excluded). */
  toolEvidence: PacketEvidence[];
  /** Investigation/tool trace notes relevant to the escalation. */
  logs: string[];
  /** What the local investigation tried, in order. */
  attemptedDiagnosis: string[];
  /** Questions the local investigation could not resolve. */
  unresolvedQuestions: string[];
  /** Constraints the stronger model must respect. */
  constraints: string[];
  /** Authorization context for the escalation. */
  authorization: {
    actorId: string;
    actorKind: string;
    visibilityCeiling: Visibility;
  };
  /** What the stronger model should produce. */
  expectedOutput: string;
  /** Number of evidence items redacted for visibility. */
  redactedEvidenceCount: number;
}

/** One evidence item as carried in the packet. */
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

export interface PacketInput {
  request: ResolvedChatRequest;
  classification: IntentClassification;
  outcome: InvestigationOutcome;
  assessments: ClaimAssessment[];
  packetRef: string;
}

/** Build the §22.2 investigation packet from a completed investigation. */
export function buildInvestigationPacket(input: PacketInput): InvestigationPacket {
  const { request, classification, outcome, assessments, packetRef } = input;

  const visibleEvidence = outcome.evidence.filter((item) =>
    isPacketVisible(item, request),
  );
  const toolEvidence: PacketEvidence[] = [];
  const redactedEvidenceCount =
    outcome.secretPayloadsDropped + outcome.evidence.length - visibleEvidence.length;
  for (const item of visibleEvidence) {
    toolEvidence.push({
      id: item.id,
      claim: item.claim,
      value: item.value,
      toolName: item.toolName,
      source: item.source,
      visibility: item.visibility,
      verificationTier: item.verificationTier,
      ...(item.version ? { version: item.version } : {}),
      ...(item.observedTime ? { observedTime: item.observedTime } : {}),
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
    });
  }

  const currentShas: Record<string, string> = {};
  for (const item of visibleEvidence) {
    if (item.version !== undefined && item.sourceStatus === SourceStatus.CURRENT) {
      currentShas[item.source] = item.version;
    }
  }

  const attemptedDiagnosis = outcome.executedCalls.map(describeCall);
  for (const note of outcome.notes) {
    attemptedDiagnosis.push(note);
  }

  const unresolvedQuestions: string[] = [];
  for (const assessment of assessments) {
    if (assessment.verdict === 'unsupported') {
      unresolvedQuestions.push(
        `No current evidence found for claim "${assessment.claim}".`,
      );
    } else if (assessment.verdict === 'contradicted') {
      unresolvedQuestions.push(
        `Conflicting current evidence for claim "${assessment.claim}": ` +
          assessment.contradicting
            .map((i) => `${i.source} says "${i.value}"`)
            .join('; '),
      );
    }
  }
  if (outcome.termination === 'budget_exhausted') {
    unresolvedQuestions.push(
      'Local tool budget was exhausted before the investigation completed.',
    );
  }
  if (outcome.termination === 'repeated_tool_failures') {
    unresolvedQuestions.push(
      `Local tools failed repeatedly (${outcome.consecutiveFailures} consecutive failures).`,
    );
  }

  return {
    packetRef,
    traceId: request.traceId,
    userQuestion: request.message,
    goal: classification.summary,
    requestClass: classification.requestClass,
    relevantRepositories: extractRepositories(visibleEvidence),
    relevantFiles: extractFiles(visibleEvidence),
    currentShas,
    toolEvidence,
    logs: [...outcome.notes],
    attemptedDiagnosis,
    unresolvedQuestions,
    constraints: [
      'Do not disclose SECRET_DENY material (§17.6).',
      'Respect the visibility ceiling: ' +
        `${request.visibilityCeiling} (§17).`,
      'Verify mutable Enthusia facts against current sources before asserting (§11).',
      'No production writes without explicit staff authorization (§22.4).',
    ],
    authorization: {
      actorId: request.actor.id,
      actorKind: request.actor.type,
      visibilityCeiling: request.visibilityCeiling,
    },
    expectedOutput:
      'Diagnosis and, where authorized, a concrete code change proposal ' +
      'with file paths, current SHAs, and verification steps.',
    redactedEvidenceCount,
  };
}

function describeCall(call: ExecutedToolCall): string {
  if (call.blocked) {
    return `refused ${call.toolName}: ${call.blockReason ?? 'blocked'}`;
  }
  const claim = call.claim ? ` for claim "${call.claim}"` : '';
  return call.ok
    ? `called ${call.toolName}${claim} (${call.durationMs}ms)`
    : `called ${call.toolName}${claim} — FAILED${call.errorCode ? ` (${call.errorCode})` : ''}`;
}

/**
 * Derive implicated repositories from evidence sources.
 * Convention: sources shaped like `github:<owner>/<repo>@<sha>:<path>`.
 */
export function extractRepositories(evidence: EvidenceItem[]): string[] {
  const repos = new Set<string>();
  for (const item of evidence) {
    const match = /^github:([^@\s]+)@/.exec(item.source);
    if (match?.[1]) {
      repos.add(match[1]);
    }
  }
  return [...repos].sort();
}

/** Derive implicated file paths from evidence sources (`...:<path>` suffix). */
export function extractFiles(evidence: EvidenceItem[]): string[] {
  const files = new Set<string>();
  for (const item of evidence) {
    const match = /^github:[^@\s]+@[^:\s]+:(.+)$/.exec(item.source);
    if (match?.[1]) {
      files.add(match[1]);
    }
  }
  return [...files].sort();
}

/** Packet visibility helper: is this evidence item allowed in the packet? */
export function isPacketVisible(
  item: EvidenceItem,
  request: ResolvedChatRequest,
): boolean {
  return (
    item.visibility !== Visibility.SECRET_DENY &&
    canDisclose(item.visibility, request.visibilityCeiling, {
      isStaff: request.actor.type === 'staff',
    })
  );
}
