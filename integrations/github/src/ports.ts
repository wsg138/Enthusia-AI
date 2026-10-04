/**
 * @enthusia/integration-github — integration ports (W08).
 *
 * Structural seams for the two workstreams this indexer drives:
 *
 * - W04 `SourceRegistry` (`packages/source-provenance`): artifact lifecycle
 *   (register with atomic supersession).
 * - W07 `KnowledgeRetrievalEngine`
 *   (`services/knowledge-indexer/src/retrieval`): chunking + chunk indexing
 *   with status propagation.
 *
 * These interfaces mirror the W04/W07 public APIs exactly (method names,
 * parameter order, and result shapes were copied from PR #4 / PR #12), so
 * the real implementations satisfy these ports structurally with NO
 * adapter and NO modification to W04/W07 code. Composition (done outside
 * this package, once those PRs merge) injects the real instances:
 *
 *   new GitHubIndexer(config, {
 *     client,
 *     registry: new SourceRegistry(store),            // W04
 *     retrieval: new KnowledgeRetrievalEngine(deps),   // W07
 *   });
 *
 * Until then, tests and MVP wiring use the in-test fakes in
 * `test/fakes.ts`, which replicate the W04/W07 semantics.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 23; WORKER-EXECUTION-PLAN.md §11.
 */

import {
  type ContentMetadata,
  type SourceArtifact,
  SourceStatus,
  SourceType,
  Visibility,
} from '@enthusia/contracts';

// ---------------------------------------------------------------------------
// W04 SourceRegistry port
// ---------------------------------------------------------------------------

/** Mirrors W04 `RegisterOutcome`. */
export type RegisterOutcome = 'CREATED' | 'UNCHANGED' | 'SUPERSEDED';

/** Mirrors W04 `RegisterArtifactInput` (PR #4, registry.ts). */
export interface RegisterArtifactInput {
  sourceType: SourceType;
  /** Version-independent source identity, e.g. 'github:wsg138/EnthusiaStaff:config.yml'. */
  sourceLocator: string;
  /** Subsystem that produced/owns the artifact (e.g. 'knowledge-indexer'). */
  component: string;
  /** Who/what asserts this artifact (e.g. 'github:wsg138/EnthusiaStaff'). */
  authority: string;
  /** Version or content hash of the source at observation time. */
  version: string;
  /** ISO 8601 observed time; defaults to now. */
  observedTime?: string;
  /** Explicit visibility. Required unless useDefaultVisibility is set. */
  visibility?: Visibility;
  /** Opt in to the conservative per-source-type default visibility. */
  useDefaultVisibility?: boolean;
  contentMetadata?: ContentMetadata;
  parserVersion?: string;
  embeddingVersion?: string;
}

/** Mirrors W04 `StoredSourceArtifact` (PR #4, store.ts). */
export interface StoredArtifact extends SourceArtifact {
  status: SourceStatus;
}

/** Mirrors W04 `RegisterResult` (PR #4, registry.ts). */
export interface RegisterResult {
  artifact: StoredArtifact;
  outcome: RegisterOutcome;
  /** Set when outcome is SUPERSEDED: the artifact that was replaced. */
  supersededArtifactId?: string;
}

/**
 * Structural port satisfied by W04 `SourceRegistry`.
 * Only the methods this indexer needs are declared.
 */
export interface ArtifactRegistryPort {
  /**
   * Register a source artifact.
   * - Unknown locator -> CURRENT, outcome CREATED.
   * - Same locator + unchanged version -> no-op, outcome UNCHANGED.
   * - Same locator + changed version -> atomic supersession: old CURRENT
   *   becomes SUPERSEDED (kept as history), new becomes CURRENT,
   *   outcome SUPERSEDED with supersededArtifactId set.
   */
  register(input: RegisterArtifactInput): RegisterResult;
  /** Current artifact for a locator, if any (W04 `getCurrent`). */
  getCurrent(sourceLocator: string): StoredArtifact | undefined;
  /**
   * List trusted CURRENT artifacts, optionally filtered by source type
   * and/or component (W04 `listCurrent`). Used to detect files that were
   * deleted from the repository between runs.
   */
  listCurrent(filter?: { sourceType?: SourceType; component?: string }): StoredArtifact[];
  /** Mark an artifact INVALID: source deleted or no longer trustworthy. */
  markInvalid(artifactId: string): StoredArtifact;
  /** Mark a CURRENT head STALE when freshness cannot be proven. */
  markStale(artifactId: string): StoredArtifact;
  /** Revalidate a STALE head after the same source version is observed again. */
  revalidate(artifactId: string, observedTime?: string): StoredArtifact;
}

// ---------------------------------------------------------------------------
// W07 KnowledgeRetrievalEngine port
// ---------------------------------------------------------------------------

/** Mirrors W07 `TextChunk` (PR #12, chunking.ts). */
export interface TextChunkCut {
  text: string;
  /** Offset of the first character in the source document. */
  charStart: number;
  /** Offset one past the last character in the source document. */
  charEnd: number;
  /** Nearest enclosing heading, when the chunker tracks document structure. */
  heading?: string;
}

/** Mirrors W07 `Chunker` (PR #12, chunking.ts). */
export interface TextChunker {
  /** Stable name recorded for debugging/provenance. */
  readonly name: string;
  /** Split `text` into chunks. Must be deterministic for the same input. */
  chunk(text: string): TextChunkCut[];
}

/** Mirrors W07 `KnowledgeChunk` (PR #12, types.ts). */
export interface IndexedChunk {
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
  /** Embedding model+version used for this chunk's vector. */
  embeddingVersion?: string;
  /** Free-form indexer metadata (extracted entities, headings, ...). */
  metadata?: Record<string, unknown>;
}

/**
 * Structural port satisfied by W07 `KnowledgeRetrievalEngine`.
 * Only the methods this indexer needs are declared.
 */
export interface RetrievalEnginePort {
  /**
   * Chunk an artifact's full text and index the resulting chunks with
   * provenance copied from the artifact (W07 `indexArtifactText`).
   */
  indexArtifactText(
    artifact: SourceArtifact,
    status: SourceStatus,
    text: string,
    chunker?: TextChunker,
  ): Promise<IndexedChunk[]>;
  /**
   * Propagate a lifecycle change: every chunk of the artifact adopts the
   * new status snapshot, so supersession takes effect in retrieval
   * without a full re-index (W07 `updateArtifactStatus`).
   *
   * @returns number of chunks updated.
   */
  updateArtifactStatus(artifactId: string, status: SourceStatus): Promise<number>;
}
