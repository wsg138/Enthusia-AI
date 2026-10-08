/**
 * @enthusia/memory — service-level types (W05).
 *
 * Contract shapes (MemoryKey, MemoryRevision, MemoryEvidence, EvidenceRole,
 * SourceStatus) are imported from `@enthusia/contracts` per the W01 contract.
 */

import type {
  MemoryEvidence,
  MemoryKey,
  MemoryRevision,
  MemoryRevisionStatus,
} from '@enthusia/contracts';
import { EvidenceRole, SourceStatus, Visibility } from '@enthusia/contracts';

export type { MemoryKey, MemoryRevision, MemoryEvidence, MemoryRevisionStatus };
export { EvidenceRole, SourceStatus, Visibility };

/** Logical identity of a memory (namespace/key/scope tuple, §3 of the memory spec). */
export interface MemoryRef {
  namespace: string;
  key: string;
  scope: string;
}

/** Evidence to attach to a revision. */
export interface EvidenceInput {
  sourceArtifactId: string;
  sourceVersion: string;
  evidenceRole: EvidenceRole;
  observedAt?: string;
  verifiedAt?: string;
  authorityLevel?: string;
}

/** A stored revision row with its key and evidence attached. */
export interface StoredRevision extends MemoryRevision {
  key: MemoryKey;
  evidence: MemoryEvidence[];
}

/** What a current-only query returns: the CURRENT revision plus its key. */
export interface CurrentMemory {
  key: MemoryKey;
  revision: StoredRevision;
}

/** Options for creating the first revision of a key. */
export interface CreateRevisionInput extends MemoryRef {
  visibility?: Visibility;
  value: unknown;
  summary: string;
  authority: string;
  validFrom?: string;
  evidence?: EvidenceInput[];
}

/**
 * Options for the atomic supersession transaction
 * (MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §5).
 */
export interface SupersedeInput extends MemoryRef {
  value: unknown;
  summary: string;
  authority: string;
  /** Human reason for the change; recorded on the revision and event. */
  reason?: string;
  validFrom?: string;
  evidence?: EvidenceInput[];
  /**
   * Copy the previous revision's evidence rows onto the new revision so the
   * provenance chain stays attached to current retrieval. Previous rows are
   * always retained on the old revision (history), regardless of this flag.
   */
  inheritEvidence?: boolean;
  /**
   * Optimistic concurrency: only proceed if this revision is still the
   * CURRENT one. Mismatch throws ConcurrentModificationError.
   */
  expectedCurrentRevisionId?: string;
}

/** Rechecked immutable evidence required before a STALE value becomes CURRENT. */
export interface VerifiedSource {
  sourceArtifactId: string;
  sourceVersion: string;
}

export interface VerifyMemoryOptions {
  authority: string;
  /** Independently re-observed exact source/version; required for STALE. */
  confirmedSource?: VerifiedSource;
  /** Reject an in-flight recheck when another writer replaces the revision. */
  expectedRevisionId?: string;
}

/** Options for marking a revision INVALID with no replacement (§13.4). */
export interface InvalidateInput extends MemoryRef {
  reason: string;
  authority: string;
}

/** Options for reporting a conflict (§16 / §13.5). */
export interface ReportConflictInput extends MemoryRef {
  authority: string;
  note?: string;
  conflictingEvidence: EvidenceInput[];
}

/**
 * Correction API input (§18): a human/system correction becomes a new
 * revision with provenance; the old revision is superseded, never erased.
 */
export interface CorrectionInput extends MemoryRef {
  value: unknown;
  summary: string;
  /** Who issued the correction, e.g. 'staff:<id>' or 'owner'. */
  actor: string;
  /** Why the correction was issued. */
  reason: string;
  evidence?: EvidenceInput[];
}

/** Cache-invalidation hook: called (inside the transaction's aftermath) with the affected key. */
export type CacheInvalidator = (ref: MemoryRef, revisionId: string) => void;

/** Events emitted by the service (also persisted to memory_events, §21). */
export type MemoryEventType =
  | 'memory.created'
  | 'memory.verified'
  | 'memory.superseded'
  | 'memory.invalidated'
  | 'memory.conflicted'
  | 'memory.restored'
  | 'memory.staled';

export interface MemoryEvent {
  type: MemoryEventType;
  key: MemoryKey;
  revisionId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type MemoryEventListener = (event: MemoryEvent) => void;
