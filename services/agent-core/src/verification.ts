/**
 * @enthusia/agent-core — claim verification (W12).
 *
 * Spec: MASTER-SPECIFICATION.md §11 (verification requirement, tiers,
 * mandatory answer grounding) and §5.3 (old memory is not current memory).
 *
 * Required policy: for mutable Enthusia facts, the final answer MUST have
 * current evidence. No evidence → the answer says "could not verify" — it
 * never guesses, and it never answers from stale model recollection.
 *
 * All verdicts here are computed deterministically from tool evidence.
 * Reasoner "claim hints" are advisory and never asserted.
 */
import { canDisclose, SourceStatus } from '@enthusia/contracts';
import type {
  MemoryRevisionStatus,
  ToolResult,
  Visibility,
} from '@enthusia/contracts';
import type {
  ClaimAssessment,
  Contradiction,
  EvidenceItem,
  MemoryIdentity,
  SupersededMemory,
  VerificationTier,
} from './types.js';
import { verificationTierRank } from './types.js';
import { decodeFreshness } from './freshness.js';

/** Default max age for tier-A (live) evidence to count as current. */
export const DEFAULT_MAX_LIVE_AGE_MS = 5 * 60 * 1000;

/** Small clock skew tolerance when comparing observed times. */
const CLOCK_SKEW_MS = 60 * 1000;

export interface VerificationOptions {
  /** Epoch milliseconds used as "now" (injectable for tests). */
  nowMs?: number;
  /** Max age for tier-A live evidence to count as current. */
  maxLiveAgeMs?: number;
}

/** Type guard: the tool result carries a successful payload. */
export function isToolSuccess<T>(
  result: ToolResult<T>,
): result is ToolResult<T> & { result: T } {
  return result.error === undefined && result.result !== undefined;
}

/**
 * Whether a tool result counts as *current* evidence (§11).
 *
 * Requirements:
 * - the call succeeded;
 * - freshness/provenance is present and decodable (§11.3: claim -> source
 *   -> version/time);
 * - the source version status is CURRENT (SUPERSEDED/INVALID/STALE/
 *   CONFLICTED are never current);
 * - tier-A (live) results were observed recently (volatile facts decay);
 * - tier-C (memory) results come from a CURRENT memory revision.
 */
export function isCurrentEvidence(
  result: ToolResult<unknown>,
  tier: VerificationTier | undefined,
  options: VerificationOptions = {},
): boolean {
  if (!isToolSuccess(result)) {
    return false;
  }
  const freshness = decodeFreshness(result.freshness, result.timestamp);
  if (!freshness) {
    return false;
  }
  if (freshness.sourceStatus !== SourceStatus.CURRENT) {
    return false;
  }
  if (freshness.version.trim().length === 0) {
    return false;
  }
  const nowMs = options.nowMs ?? Date.now();

  if (tier === 'A') {
    const observed = Date.parse(freshness.observedTime);
    if (Number.isNaN(observed)) {
      return false;
    }
    const maxAge = options.maxLiveAgeMs ?? DEFAULT_MAX_LIVE_AGE_MS;
    const age = nowMs - observed;
    if (age < -CLOCK_SKEW_MS || age > maxAge) {
      return false;
    }
    return true;
  }

  if (tier === 'C') {
    const memory = readMemoryIdentity(result.result);
    // Tier-C is specifically CURRENT structured memory. Missing memory
    // identity/status is not enough to ground a present-tense answer.
    return memory !== null && memory.status === SourceStatus.CURRENT;
  }

  // Tier B (or undeclared): versioned/indexed source, CURRENT status suffices.
  return true;
}

/**
 * Extract claim evidence from a tool result.
 *
 * Accepted payload shapes:
 * - `{ value: string, excerpt?: string, memory?: {...} }`
 * - a bare string (treated as the value)
 *
 * Anything else yields null: the result is kept in the investigation trace
 * but does not count as evidence for the claim.
 */
export function extractClaimEvidence(
  id: string,
  claim: string,
  toolName: string,
  result: ToolResult<unknown>,
  tier: VerificationTier | undefined,
  options: VerificationOptions = {},
): EvidenceItem | null {
  if (!isToolSuccess(result)) {
    return null;
  }
  const extracted = extractValue(result.result);
  if (!extracted) {
    return null;
  }
  const effectiveTier: VerificationTier = tier ?? 'B';
  const freshness = decodeFreshness(result.freshness, result.timestamp);
  const item: EvidenceItem = {
    id,
    claim,
    value: extracted.value,
    toolName,
    source: result.source,
    visibility: result.visibility,
    verificationTier: effectiveTier,
    current: isCurrentEvidence(result, tier, options),
  };
  if (freshness) {
    item.version = freshness.version;
    item.observedTime = freshness.observedTime;
    item.sourceStatus = freshness.sourceStatus;
  }
  if (extracted.excerpt !== undefined) {
    item.excerpt = extracted.excerpt;
  }
  if (extracted.memory !== undefined) {
    item.memory = extracted.memory;
  }
  return item;
}

function extractValue(
  result: unknown,
): { value: string; excerpt?: string; memory?: MemoryIdentity } | null {
  if (typeof result === 'string') {
    const value = result.trim();
    return value.length > 0 ? { value } : null;
  }
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    const payload = result as Record<string, unknown>;
    if (typeof payload['value'] === 'string') {
      const value = (payload['value'] as string).trim();
      if (value.length === 0) {
        return null;
      }
      const out: {
        value: string;
        excerpt?: string;
        memory?: MemoryIdentity;
      } = { value };
      if (typeof payload['excerpt'] === 'string') {
        out.excerpt = payload['excerpt'];
      }
      const memory = readMemoryIdentity(payload);
      if (memory) {
        out.memory = memory;
      }
      return out;
    }
  }
  return null;
}

function readMemoryIdentity(value: unknown): MemoryIdentity | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  // New convention: payload.memory = { keyId, namespace?, key?, scope?, status? }
  const memory = record['memory'];
  if (memory !== null && typeof memory === 'object' && !Array.isArray(memory)) {
    const m = memory as Record<string, unknown>;
    if (typeof m['keyId'] === 'string' && m['keyId'].length > 0) {
      const identity: MemoryIdentity = { keyId: m['keyId'] };
      if (typeof m['namespace'] === 'string') {
        identity.namespace = m['namespace'];
      }
      if (typeof m['key'] === 'string') {
        identity.key = m['key'];
      }
      if (typeof m['scope'] === 'string') {
        identity.scope = m['scope'];
      }
      if (typeof m['status'] === 'string' && isMemoryStatus(m['status'])) {
        identity.status = m['status'];
      }
      return identity;
    }
  }
  // Legacy flat convention: payload.memoryKeyId / payload.memoryStatus.
  if (typeof record['memoryKeyId'] === 'string') {
    const identity: MemoryIdentity = {
      keyId: record['memoryKeyId'],
    };
    if (
      typeof record['memoryStatus'] === 'string' &&
      isMemoryStatus(record['memoryStatus'])
    ) {
      identity.status = record['memoryStatus'];
    }
    return identity;
  }
  return null;
}

function isMemoryStatus(value: string): value is MemoryRevisionStatus {
  return (Object.values(SourceStatus) as string[]).includes(value);
}

/** Fold a value for contradiction comparison (case/whitespace-insensitive). */
export function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Detect contradictions among current evidence: two or more current items
 * for the same claim with different normalized values.
 *
 * Memory-vs-stronger-source disagreements are NOT contradictions — they are
 * stale-memory signals handled by {@link assessClaim} (the stronger tier
 * wins and the memory is proposed for supersession).
 */
export function detectContradictions(evidence: EvidenceItem[]): Contradiction[] {
  const contradictions: Contradiction[] = [];
  const byClaim = new Map<string, EvidenceItem[]>();
  for (const item of evidence) {
    if (!item.current) continue;
    const list = byClaim.get(item.claim);
    if (list) {
      list.push(item);
    } else {
      byClaim.set(item.claim, [item]);
    }
  }
  for (const [claim, items] of byClaim) {
    const values = new Set(items.map((i) => normalizeValue(i.value)));
    if (values.size < 2) continue;
    // A lone memory item losing to stronger tiers is stale memory, not a
    // contradiction: only flag when the top tier itself disagrees.
    const topRank = Math.max(
      ...items.map((i) => verificationTierRank(i.verificationTier)),
    );
    const topItems = items.filter(
      (i) => verificationTierRank(i.verificationTier) === topRank,
    );
    const topValues = new Set(topItems.map((i) => normalizeValue(i.value)));
    if (topValues.size < 2) continue;
    contradictions.push({
      claim,
      items: topItems,
      description:
        `conflicting current evidence for "${claim}": ` +
        topItems.map((i) => `${i.source} says "${i.value}"`).join('; '),
    });
  }
  return contradictions;
}

/**
 * Assess one claim against gathered evidence.
 *
 * - no current evidence → `unsupported` (answer: "could not verify");
 * - all current evidence agrees → `supported` (answer may assert the value);
 * - top-tier sources disagree → `contradicted` (surface uncertainty,
 *   escalate — never pick randomly);
 * - a weaker source (typically memory) disagrees with a stronger one →
 *   `supported` by the stronger source, and the stale memory is reported
 *   via `supersededMemories` so the orchestrator can *propose* an update.
 */
export function assessClaim(
  claim: string,
  evidence: EvidenceItem[],
): ClaimAssessment {
  const items = evidence.filter((i) => i.claim === claim && i.current);
  if (items.length === 0) {
    return {
      claim,
      verdict: 'unsupported',
      supporting: [],
      contradicting: [],
      supersededMemories: [],
    };
  }

  const groups = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    const key = normalizeValue(item.value);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  const first = items[0] as EvidenceItem;
  if (groups.size === 1) {
    return {
      claim,
      verdict: 'supported',
      supporting: items,
      contradicting: [],
      assertedValue: first.value,
      supersededMemories: [],
    };
  }

  const topRank = Math.max(
    ...items.map((i) => verificationTierRank(i.verificationTier)),
  );
  const topGroups = [...groups.values()].filter((group) =>
    group.some((i) => verificationTierRank(i.verificationTier) === topRank),
  );

  if (topGroups.length === 1) {
    const winnerGroup = topGroups[0] as EvidenceItem[];
    const winner = winnerGroup[0] as EvidenceItem;
    const supersededMemories: SupersededMemory[] = [];
    const contradicting: EvidenceItem[] = [];
    for (const group of groups.values()) {
      if (group === winnerGroup) continue;
      for (const item of group) {
        contradicting.push(item);
        if (item.memory) {
          supersededMemories.push({
            memoryKeyId: item.memory.keyId,
            ...(item.memory.namespace !== undefined
              ? { memoryNamespace: item.memory.namespace }
              : {}),
            ...(item.memory.key !== undefined
              ? { memoryKey: item.memory.key }
              : {}),
            ...(item.memory.scope !== undefined
              ? { memoryScope: item.memory.scope }
              : {}),
            oldValue: item.value,
            newValue: winner.value,
            evidenceIds: winnerGroup.map((w) => w.id),
          });
        }
      }
    }
    return {
      claim,
      verdict: 'supported',
      supporting: winnerGroup,
      contradicting,
      assertedValue: winner.value,
      supersededMemories,
    };
  }

  // Top tier disagrees with itself: genuine contradiction.
  return {
    claim,
    verdict: 'contradicted',
    supporting: [],
    contradicting: items,
    supersededMemories: [],
  };
}

/** Assess every claim the classification says the answer needs. */
export function assessAllClaims(
  claims: string[],
  evidence: EvidenceItem[],
): ClaimAssessment[] {
  return claims.map((claim) => assessClaim(claim, evidence));
}

/** §17 disclosure options for evidence filtering. */
export interface DisclosureFilter {
  ceiling: Visibility;
  isSubject?: boolean;
  isStaff?: boolean;
}

/**
 * Assess a claim using only evidence disclosable to the actor.
 *
 * The *answer text* must never assert (or leak) values the actor may not
 * see: a claim supported only by above-ceiling evidence is `unsupported`
 * from the actor's perspective ("could not verify"). The full-evidence
 * assessment is still used for escalation and packets, where staff/stronger
 * models may see more.
 */
export function assessClaimDisclosable(
  claim: string,
  evidence: EvidenceItem[],
  filter: DisclosureFilter,
): ClaimAssessment {
  const opts: { isSubject?: boolean; isStaff?: boolean } = {};
  if (filter.isSubject !== undefined) {
    opts.isSubject = filter.isSubject;
  }
  if (filter.isStaff !== undefined) {
    opts.isStaff = filter.isStaff;
  }
  return assessClaim(
    claim,
    evidence.filter((item) => canDisclose(item.visibility, filter.ceiling, opts)),
  );
}

/** Disclosable assessment for every claim (drives the response text). */
export function assessAllClaimsDisclosable(
  claims: string[],
  evidence: EvidenceItem[],
  filter: DisclosureFilter,
): ClaimAssessment[] {
  return claims.map((claim) => assessClaimDisclosable(claim, evidence, filter));
}
