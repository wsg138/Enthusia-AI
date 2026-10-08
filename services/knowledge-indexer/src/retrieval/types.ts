/**
 * @enthusia/knowledge-indexer — retrieval engine types.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 39;
 * MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §§13-15;
 * WORKER-EXECUTION-PLAN.md §10 (W07).
 *
 * Core invariant (NON-NEGOTIABLE): default retrieval returns CURRENT chunks
 * only. SUPERSEDED content is historical and requires explicit opt-in via
 * `includeHistorical` (or an explicit `statuses` override).
 */

import type { SourceStatus, SourceType, Visibility } from '@enthusia/contracts';

/** Identity/authorization of the caller for visibility-ceiling enforcement. */
export interface RequesterContext {
  /**
   * True when the requester is the subject player of PLAYER_SELF content.
   * Required (with isStaff) for PLAYER_SELF disclosure per contracts §17.
   */
  isSubject?: boolean;
  /** True when the requester is authorized staff. */
  isStaff?: boolean;
}

/**
 * A searchable unit of indexed content.
 *
 * A chunk always carries the provenance of the source artifact it was cut
 * from, plus a snapshot of that artifact's lifecycle status at index time.
 * Status snapshots are refreshed via
 * `KnowledgeRetrievalEngine.updateArtifactStatus` when the source registry
 * (W04) supersedes/invalidates an artifact — per verification spec §15 the
 * current-only filter must be metadata-driven, never reliant on text labels.
 */
export interface KnowledgeChunk {
  /** Stable chunk identity, e.g. `<artifactId>#<chunkIndex>`. */
  chunkId: string;
  /** Source artifact this chunk was cut from. */
  artifactId: string;
  /** Artifact version (fingerprint: SHA, file hash, doc version) at index time. */
  version: string;
  /** Lifecycle status snapshot (CURRENT / SUPERSEDED / INVALID / ...). */
  status: SourceStatus;
  visibility: Visibility;
  sourceType: SourceType;
  /** Subsystem that produced/owns the artifact (e.g. 'knowledge-indexer'). */
  component: string;
  /** Who/what asserts the artifact (e.g. 'github:wsg138/EnthusiaStaff'). */
  authority: string;
  /** Version-independent source identity, e.g. 'github:wsg138/EnthusiaStaff:config.yml'. */
  sourceLocator: string;
  /** The searchable text of this chunk. */
  text: string;
  /** Ordinal of this chunk within its artifact. */
  chunkIndex: number;
  /** Approximate token count of `text`, when computed. */
  tokenCount?: number;
  /** Embedding model+version used for this chunk's vector, e.g. 'hashing-test-v1'. */
  embeddingVersion?: string;
  /** Free-form indexer metadata (extracted entities, headings, ...). */
  metadata?: Record<string, unknown>;
}

/** Provenance attached to every retrieval hit (acceptance: provenance + version). */
export interface ChunkProvenance {
  artifactId: string;
  version: string;
  status: SourceStatus;
  visibility: Visibility;
  sourceType: SourceType;
  component: string;
  authority: string;
  sourceLocator: string;
  chunkId: string;
  chunkIndex: number;
}

/** Structured metadata filters applied before ranking. */
export interface ChunkFilters {
  sourceType?: SourceType;
  component?: string;
  visibility?: Visibility;
  version?: string;
  authority?: string;
  artifactId?: string;
  sourceLocator?: string;
}

/** Relative contribution of each retrieval signal to the hybrid score. */
export interface RankWeights {
  vector: number;
  lexical: number;
}

export const DEFAULT_RANK_WEIGHTS: RankWeights = { vector: 0.5, lexical: 0.5 };

/**
 * Exact deployment evidence for current-production retrieval. GitHub source
 * is not production evidence by itself: a GitHub chunk is eligible only when
 * its indexed commit SHA exactly matches the deployed SHA supplied for that
 * source authority.
 */
export interface ProductionSearchContext {
  /** Exact deployed Git commit SHA keyed by chunk authority/repository identity. */
  deployedGitShas: Readonly<Record<string, string>>;
}

/** Options for `KnowledgeRetrievalEngine.search`. */
export interface SearchOptions {
  /**
   * REQUIRED. Maximum visibility the caller may see. Results are filtered
   * with `canDisclose` BEFORE they reach the caller — there is no
   * post-hoc redaction step.
   */
  visibilityCeiling: Visibility;
  /** Caller identity for PLAYER_SELF disclosure checks. */
  requester?: RequesterContext;
  /**
   * Current-production verification context. When present, GitHub chunks fail
   * closed unless their indexed commit SHA exactly matches verified deployed
   * evidence supplied for the chunk authority. This prevents Git main from
   * being treated as production merely because it is CURRENT in the source
   * registry.
   */
  production?: ProductionSearchContext;
  /**
   * Explicit opt-in for historical content. Default false → only CURRENT
   * chunks are eligible. When true, SUPERSEDED chunks become eligible and
   * are marked `historical: true` in results (temporal framing, spec §14).
   */
  includeHistorical?: boolean;
  /**
   * Explicit status override. Providing this IS the explicit opt-in for
   * whatever statuses it lists (e.g. `[CURRENT, SUPERSEDED]` or
   * `[CONFLICTED]` for investigation per verification spec §13).
   * INVALID is never included unless explicitly listed.
   */
  statuses?: SourceStatus[];
  /** Structured metadata filters (AND-combined). */
  filters?: ChunkFilters;
  /** Max hits to return. Default 10, clamped to [1, 200]. */
  limit?: number;
  /** Hits to skip (pagination). Default 0. */
  offset?: number;
  /** Hybrid signal weights. Default { vector: 0.5, lexical: 0.5 }. */
  weights?: RankWeights;
  /** Minimum combined score (0..1) for a hit. Default 0. */
  minScore?: number;
}

/** A single ranked retrieval hit. */
export interface RetrievalHit {
  chunk: KnowledgeChunk;
  provenance: ChunkProvenance;
  /** Combined hybrid score, normalized to 0..1. */
  score: number;
  /** Cosine similarity component, 0..1, when vector search contributed. */
  vectorScore?: number;
  /** Lexical component, 0..1, when lexical search contributed. */
  lexicalScore?: number;
  /** True when an exact identifier match (§39) contributed to this hit. */
  exactMatch: boolean;
  /**
   * True when the chunk's status is not CURRENT. Historical hits carry
   * temporal framing per MEMORY-KNOWLEDGE-VERIFICATION-SPEC §14 — callers
   * must surface this, never present the content as current.
   */
  historical: boolean;
}

/** Response envelope for `search`. */
export interface SearchResponse {
  results: RetrievalHit[];
  /** Number of eligible hits before offset/limit. */
  total: number;
  query: string;
  /** Statuses that were eligible for this query. */
  effectiveStatuses: SourceStatus[];
  /** True when historical content was eligible. */
  historicalMode: boolean;
  /** True when current-production deployment verification was enforced. */
  productionMode: boolean;
}

/** Build the provenance block for a chunk. */
export function provenanceOf(chunk: KnowledgeChunk): ChunkProvenance {
  return {
    artifactId: chunk.artifactId,
    version: chunk.version,
    status: chunk.status,
    visibility: chunk.visibility,
    sourceType: chunk.sourceType,
    component: chunk.component,
    authority: chunk.authority,
    sourceLocator: chunk.sourceLocator,
    chunkId: chunk.chunkId,
    chunkIndex: chunk.chunkIndex,
  };
}
