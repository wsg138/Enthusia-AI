/**
 * @enthusia/agent-core — memory update proposals (W12).
 *
 * Spec §13 (two-layer memory model) and §15.1 step 10 (record useful
 * evidence-backed memory/corrections). The orchestrator PROPOSES memory
 * changes as wire `MemoryUpdateProposal`s; W05 (memory service) owns the
 * actual writes — this package never writes memory directly.
 *
 * Proposal rules enforced here:
 * - every proposal must reference backing evidence (no evidence → dropped);
 * - proposals target a concrete namespace/key/scope with a value;
 * - last-writer-wins deduplication per memory identity;
 * - values that look like secrets are dropped (§17.6).
 */
import type { MemoryUpdateProposal } from '@enthusia/contracts';
import type { EvidenceItem, SupersededMemory } from './types.js';

/** Default namespace/scope for agent-core proposals when unset. */
export const PROPOSAL_NAMESPACE = 'agent-core';
export const PROPOSAL_SCOPE = 'global';

/** Build a proposal from a stale-memory detection (§5.3, §13.9). */
export function proposalFromSuperseded(
  superseded: SupersededMemory,
): MemoryUpdateProposal {
  const evidenceNote =
    superseded.evidenceIds.length > 0
      ? ` Evidence: ${superseded.evidenceIds.join(', ')}.`
      : '';
  return {
    namespace: superseded.memoryNamespace ?? PROPOSAL_NAMESPACE,
    key: superseded.memoryKey ?? superseded.memoryKeyId,
    scope: superseded.memoryScope ?? PROPOSAL_SCOPE,
    summary:
      `Superseded by current evidence: was "${superseded.oldValue}", ` +
      `now "${superseded.newValue}".${evidenceNote}`,
    value: superseded.newValue,
  };
}

/**
 * Validate and normalize a batch of proposals. Drops:
 * - proposals with an empty namespace/key/scope or undefined value;
 * - proposals whose summary carries no evidence reference when one is
 *   required (see below);
 * - values that look like secrets (fail closed, §17.6);
 * keeping the last proposal per memory identity.
 *
 * The wire proposal has no evidence-reference field, so proposals produced
 * by the reasoner must name their evidence in `summary` (convention:
 * "Evidence: <id>, <id>") or they are dropped — ungrounded memory writes
 * are never proposed.
 */
export function normalizeMemoryProposals(
  proposals: MemoryUpdateProposal[],
  evidence: EvidenceItem[],
): MemoryUpdateProposal[] {
  const knownIds = new Set(evidence.map((e) => e.id));
  const byIdentity = new Map<string, MemoryUpdateProposal>();

  for (const proposal of proposals) {
    if (!proposal || typeof proposal !== 'object') continue;
    const namespace =
      typeof proposal.namespace === 'string'
        ? proposal.namespace.trim()
        : '';
    const key = typeof proposal.key === 'string' ? proposal.key.trim() : '';
    const scope =
      typeof proposal.scope === 'string' ? proposal.scope.trim() : '';
    if (
      namespace.length === 0 ||
      key.length === 0 ||
      scope.length === 0 ||
      proposal.value === undefined
    ) {
      continue;
    }
    const summary =
      typeof proposal.summary === 'string' ? proposal.summary : '';
    if (!summaryMentionsKnownEvidence(summary, knownIds)) {
      continue;
    }
    if (looksLikeSecret(proposal.value)) continue;
    byIdentity.set(`${namespace}/${key}/${scope}`, {
      namespace,
      key,
      scope,
      summary,
      value: proposal.value,
    });
  }

  return [...byIdentity.values()];
}

/**
 * The wire proposal carries no structured evidence references, so the
 * summary must name at least one known evidence id ("Evidence: e1, e2").
 * This keeps every proposed write traceable to investigation evidence.
 */
function summaryMentionsKnownEvidence(
  summary: string,
  knownIds: Set<string>,
): boolean {
  for (const id of knownIds) {
    if (summary.includes(id)) {
      return true;
    }
  }
  return false;
}

/**
 * Fail-closed secret heuristic: never propose storing something that looks
 * like a credential. Real secret handling belongs to §17.6 tooling; this is
 * a last line of defense, not a detector.
 */
export function looksLikeSecret(value: unknown): boolean {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      return true; // unserializable → fail closed
    }
  }
  return /(\b(token|secret|password|passwd|api[_-]?key|private[_-]?key|bearer)\b\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(
    text,
  );
}
