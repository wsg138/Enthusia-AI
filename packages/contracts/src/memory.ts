import { z } from 'zod';
import { Visibility } from './visibility.js';
import { MEMORY_REVISION_STATUSES, type MemoryRevisionStatus } from './source-status.js';

/**
 * Memory storage contracts.
 *
 * Spec: MASTER-SPECIFICATION.md §13 / §49 and
 * MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md.
 *
 * Two-layer model: current memory (materialized best-supported conclusions;
 * normal retrieval reads only CURRENT) and memory history (prior revisions).
 */

export interface MemoryKey {
  /** Stable row identity. */
  id: string;
  /** Logical namespace, e.g. 'network', 'permission', 'rank', 'procedure'. */
  namespace: string;
  /** Concept key, e.g. 'connection.ip', 'command.fly'. Identifies the concept, not a value. */
  key: string;
  /** Scope, e.g. 'global', 'smp', 'hub'. */
  scope: string;
  visibility: Visibility;
}

export interface MemoryRevision {
  id: string;
  memoryKeyId: string;
  /** The stored value (JSON-serializable). */
  value: unknown;
  /** Short human-readable summary of the value. */
  summary: string;
  status: MemoryRevisionStatus;
  /** ISO 8601 — when this value became (or becomes) valid. */
  validFrom: string;
  /** ISO 8601 — when this value stopped being valid, if ever. */
  validTo?: string;
  /** ISO 8601 — row creation time. */
  createdAt: string;
  /** ISO 8601 — last time the value was verified against evidence. */
  verifiedAt?: string;
  /** Who/what asserts this revision (e.g. 'indexer', 'staff:<id>'). */
  authority: string;
  /** IDs of MemoryEvidence rows supporting this revision. */
  evidenceReferences: string[];
  /** Revision this one replaced (for SUPERSEDED chains). */
  supersedesRevisionId?: string;
  /** Revision that replaced this one (for SUPERSEDED chains). */
  supersededByRevisionId?: string;
}

/** Role a piece of evidence plays for a revision. */
export enum EvidenceRole {
  PRIMARY = 'PRIMARY',
  SUPPORTING = 'SUPPORTING',
  CONTRADICTING = 'CONTRADICTING',
  SUPERSEDING = 'SUPERSEDING',
}

export interface MemoryEvidence {
  /** Stable row identity (referenced by MemoryRevision.evidenceReferences). */
  id: string;
  revisionId: string;
  /** Source artifact backing this evidence. */
  sourceArtifactId: string;
  /** Version/hash of the source artifact at evidence time. */
  sourceVersion: string;
  evidenceRole: EvidenceRole;
}

export const memoryKeySchema = z.object({
  id: z.string().min(1),
  namespace: z.string().min(1),
  key: z.string().min(1),
  scope: z.string().min(1),
  visibility: z.nativeEnum(Visibility),
});

export const memoryRevisionSchema = z.object({
  id: z.string().min(1),
  memoryKeyId: z.string().min(1),
  value: z.unknown(),
  summary: z.string().min(1),
  status: z.enum(MEMORY_REVISION_STATUSES),
  validFrom: z.string().datetime({ offset: true }),
  validTo: z.string().datetime({ offset: true }).optional(),
  createdAt: z.string().datetime({ offset: true }),
  verifiedAt: z.string().datetime({ offset: true }).optional(),
  authority: z.string().min(1),
  evidenceReferences: z.array(z.string().min(1)),
  supersedesRevisionId: z.string().optional(),
  supersededByRevisionId: z.string().optional(),
});

export const memoryEvidenceSchema = z.object({
  id: z.string().min(1),
  revisionId: z.string().min(1),
  sourceArtifactId: z.string().min(1),
  sourceVersion: z.string().min(1),
  evidenceRole: z.nativeEnum(EvidenceRole),
});
