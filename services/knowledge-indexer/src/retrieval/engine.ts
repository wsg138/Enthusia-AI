/**
 * @enthusia/knowledge-indexer — knowledge retrieval engine (W07).
 *
 * Hybrid (vector + lexical) evidence search across indexed artifacts.
 *
 * NON-NEGOTIABLE invariants enforced here:
 * 1. Default retrieval returns CURRENT chunks only. SUPERSEDED/INVALID/
 *    STALE are never normal answer candidates (verification spec §13).
 * 2. Historical content requires explicit opt-in (`includeHistorical` or an
 *    explicit `statuses` override) and is flagged `historical: true`.
 * 3. Visibility is filtered with `canDisclose` BEFORE results reach the
 *    caller. SECRET_DENY chunks are rejected at index time and can never
 *    be disclosed.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 39;
 * MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §§13-15;
 * WORKER-EXECUTION-PLAN.md §10.
 */

import {
  SourceStatus,
  SourceType,
  Visibility,
  canDisclose,
  type SourceArtifact,
} from '@enthusia/contracts';
import type { Chunker } from './chunking.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { VectorStore } from './vector-store.js';
import type { LexicalIndex } from './lexical.js';
import type { ChunkStore } from './sqlite-store.js';
import { HybridRanker, type ScoredCandidate } from './ranking.js';
import {
  provenanceOf,
  type ChunkFilters,
  type KnowledgeChunk,
  type RequesterContext,
  type RetrievalHit,
  type SearchOptions,
  type SearchResponse,
} from './types.js';

export interface RetrievalEngineDeps {
  chunkStore: ChunkStore;
  vectorStore: VectorStore;
  lexicalIndex: LexicalIndex;
  embeddingProvider: EmbeddingProvider;
  ranker?: HybridRanker;
  /** Default chunker for `indexArtifactText`. Required if that method is used. */
  defaultChunker?: Chunker;
}

const MAX_LIMIT = 200;

/**
 * Hybrid retrieval engine. Owns the search path; indexing is driven by
 * W08/W09 indexers through `indexChunks` / `indexArtifactText`, and
 * lifecycle changes (supersession) propagate via `updateArtifactStatus`.
 */
export class KnowledgeRetrievalEngine {
  private readonly chunkStore: ChunkStore;
  private readonly vectorStore: VectorStore;
  private readonly lexicalIndex: LexicalIndex;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly ranker: HybridRanker;
  private readonly defaultChunker: Chunker | undefined;
  /** In-memory chunk record mirror for filter evaluation (MVP scale). */
  private readonly chunks = new Map<string, KnowledgeChunk>();

  constructor(deps: RetrievalEngineDeps) {
    if (deps.vectorStore.dimension !== deps.embeddingProvider.dimension) {
      throw new Error(
        `vector store dimension (${deps.vectorStore.dimension}) != embedding provider dimension (${deps.embeddingProvider.dimension})`,
      );
    }
    this.chunkStore = deps.chunkStore;
    this.vectorStore = deps.vectorStore;
    this.lexicalIndex = deps.lexicalIndex;
    this.embeddingProvider = deps.embeddingProvider;
    this.ranker = deps.ranker ?? new HybridRanker();
    this.defaultChunker = deps.defaultChunker;
  }

  /**
   * Rebuild the in-memory chunk mirror and both search indexes from the
   * persistent chunk store. Call once at startup (or after external writes).
   */
  async rebuildIndexes(): Promise<void> {
    this.chunks.clear();
    await this.vectorStore.clear();
    this.lexicalIndex.clear();
    const all = this.chunkStore.listAll();
    // SECRET_DENY must never be searchable, even if written out-of-band.
    const indexable = all.filter((c) => c.visibility !== Visibility.SECRET_DENY);
    for (const c of indexable) this.chunks.set(c.chunkId, c);
    const vectors = await this.embeddingProvider.embed(indexable.map((c) => c.text));
    await this.vectorStore.upsert(
      indexable.map((c, i) => ({ id: c.chunkId, vector: (vectors[i] as number[]).slice() })),
    );
    this.lexicalIndex.add(indexable.map((c) => ({ id: c.chunkId, text: c.text })));
  }

  /**
   * Index pre-built chunks: persists them, embeds them, and adds them to
   * both search indexes. Replaces any existing chunk with the same ID.
   *
   * Rejects SECRET_DENY chunks outright — secrets are never indexed into
   * model-visible storage (contracts §17).
   *
   * @returns the indexed chunks with `embeddingVersion` stamped.
   */
  async indexChunks(chunks: KnowledgeChunk[]): Promise<KnowledgeChunk[]> {
    for (const c of chunks) {
      assertIndexableChunk(c);
    }
    const stamped = chunks.map((c) => ({
      ...c,
      embeddingVersion: this.embeddingProvider.version,
    }));

    // Compute embeddings before mutating persistence or the live indexes.
    // If embedding fails, the previously searchable state remains intact.
    const vectors = await this.embeddingProvider.embed(stamped.map((c) => c.text));

    // Persist before publishing into the in-memory eligibility mirror. If a
    // later backend write fails, the new IDs remain ineligible in this
    // process and a restart/rebuild can recover them from durable storage.
    this.chunkStore.saveChunks(stamped);
    await this.vectorStore.upsert(
      stamped.map((c, i) => ({ id: c.chunkId, vector: (vectors[i] as number[]).slice() })),
    );
    this.lexicalIndex.add(stamped.map((c) => ({ id: c.chunkId, text: c.text })));
    for (const c of stamped) this.chunks.set(c.chunkId, c);
    return stamped;
  }

  /**
   * Convenience: chunk an artifact's full text and index the resulting
   * chunks with provenance copied from the artifact.
   */
  async indexArtifactText(
    artifact: SourceArtifact,
    status: SourceStatus,
    text: string,
    chunker?: Chunker,
  ): Promise<KnowledgeChunk[]> {
    if (status === SourceStatus.CURRENT && !artifact.current) {
      throw new Error('refusing CURRENT indexing of a non-current source artifact');
    }
    const use = chunker ?? this.defaultChunker;
    if (!use) throw new Error('no chunker available: pass one or set defaultChunker');
    const cuts = use.chunk(text);
    const chunks: KnowledgeChunk[] = cuts.map((cut, i) => {
      const chunk: KnowledgeChunk = {
        chunkId: `${artifact.artifactId}#${i}`,
        artifactId: artifact.artifactId,
        version: artifact.version,
        status,
        visibility: artifact.visibility,
        sourceType: artifact.sourceType,
        component: artifact.component,
        authority: artifact.authority,
        sourceLocator: artifact.sourceLocator,
        text: cut.text,
        chunkIndex: i,
        tokenCount: estimateTokens(cut.text),
      };
      const metadata = chunkMetadata(artifact, cut.heading);
      if (metadata !== undefined) chunk.metadata = metadata;
      return chunk;
    });
    return this.indexChunks(chunks);
  }

  /**
   * Propagate a lifecycle change from the source registry (W04): every
   * chunk of the artifact adopts the new status snapshot. This is how
   * supersession takes effect in retrieval without a full re-index —
   * per verification spec §15, the current-only filter is metadata-driven.
   *
   * @returns number of chunks updated.
   */
  async updateArtifactStatus(artifactId: string, status: SourceStatus): Promise<number> {
    const updated = this.chunkStore.updateStatusByArtifact(artifactId, status);
    for (const c of this.chunks.values()) {
      if (c.artifactId === artifactId) c.status = status;
    }
    return updated;
  }

  /** Remove every chunk of an artifact from persistence and both indexes. */
  async removeArtifact(artifactId: string): Promise<void> {
    const ids: string[] = [];
    for (const [chunkId, c] of this.chunks) {
      if (c.artifactId === artifactId) {
        ids.push(chunkId);
        this.chunks.delete(chunkId);
      }
    }
    this.chunkStore.deleteByArtifact(artifactId);
    await this.vectorStore.remove(ids);
    this.lexicalIndex.remove(ids);
  }

  /**
   * Hybrid search. Filters (status, visibility, metadata) are applied
   * BEFORE scoring; the caller never sees a chunk it may not see.
   */
  async search(query: string, options: SearchOptions): Promise<SearchResponse> {
    const ceiling = options.visibilityCeiling;
    if (ceiling === undefined || ceiling === null) {
      throw new Error('search requires an explicit visibilityCeiling');
    }
    const trimmed = query.trim();
    const limit = clampLimit(options.limit);
    const offset = Math.max(0, options.offset ?? 0);
    const minScore = options.minScore ?? 0;
    const effectiveStatuses = effectiveStatusSet(options);
    const deployedGitShas = productionShas(options.production);

    if (trimmed.length === 0) {
      return {
        results: [],
        total: 0,
        query,
        effectiveStatuses,
        historicalMode: isHistorical(effectiveStatuses),
        productionMode: options.production !== undefined,
      };
    }

    // Pre-search eligibility: status + visibility + metadata filters.
    // The id predicate is pushed into both backends so ineligible chunks
    // are never scored.
    const eligible = new Set<string>();
    for (const [chunkId, chunk] of this.chunks) {
      if (
        isEligible(
          chunk,
          effectiveStatuses,
          ceiling,
          options.requester,
          options.filters,
          deployedGitShas,
        )
      ) {
        eligible.add(chunkId);
      }
    }

    const candidateTopK = Math.min(500, Math.max(20, (limit + offset) * 4));
    const idFilter = (id: string) => eligible.has(id);

    const [queryVector] = await this.embeddingProvider.embed([trimmed]);
    if (!queryVector) throw new Error('embedding provider returned no vector');
    const [vectorHits, lexicalHits] = await Promise.all([
      this.vectorStore.search(queryVector, candidateTopK, idFilter),
      Promise.resolve(this.lexicalIndex.search(trimmed, candidateTopK, idFilter)),
    ]);

    const candidates = new Map<string, ScoredCandidate>();
    for (const h of vectorHits) {
      candidates.set(h.id, { chunkId: h.id, vectorScore: h.score, exactMatch: false });
    }
    for (const h of lexicalHits) {
      const existing = candidates.get(h.id);
      if (existing) {
        existing.lexicalScore = h.score;
        existing.exactMatch = existing.exactMatch || h.exactMatch;
      } else {
        candidates.set(h.id, { chunkId: h.id, lexicalScore: h.score, exactMatch: h.exactMatch });
      }
    }

    const ranked = this.ranker.rank([...candidates.values()], options.weights);
    const historicalMode = isHistorical(effectiveStatuses);

    const hits: RetrievalHit[] = [];
    for (const r of ranked) {
      const chunk = this.chunks.get(r.chunkId);
      if (!chunk) continue; // index/store skew: never surface unknown chunks
      // A source can become STALE, INVALID or SUPERSEDED while an async
      // embedding/vector search is in flight. Recheck eligibility at publish
      // time so the pre-search snapshot cannot leak withdrawn evidence.
      if (!isEligible(
        chunk, effectiveStatuses, ceiling, options.requester,
        options.filters, deployedGitShas,
      )) continue;
      if (r.score < minScore) continue;
      const historical = chunk.status !== SourceStatus.CURRENT;
      const hit: RetrievalHit = {
        chunk,
        provenance: provenanceOf(chunk),
        score: r.score,
        exactMatch: r.exactMatch,
        historical,
      };
      if (r.vectorScore !== undefined) hit.vectorScore = r.vectorScore;
      if (r.lexicalScore !== undefined) hit.lexicalScore = r.lexicalScore;
      hits.push(hit);
    }

    const total = hits.length;
    const results = hits.slice(offset, offset + limit);
    return {
      results,
      total,
      query,
      effectiveStatuses,
      historicalMode,
      productionMode: options.production !== undefined,
    };
  }

  /** Number of chunks currently searchable through this engine. */
  indexedCount(): number {
    return this.chunks.size;
  }

  close(): void {
    this.chunkStore.close();
  }
}

/**
 * Resolve the eligible status set. Default is CURRENT only. Passing
 * `statuses` explicitly IS the opt-in for whatever it lists.
 */
function effectiveStatusSet(options: SearchOptions): SourceStatus[] {
  if (options.statuses) {
    const deduped = [...new Set(options.statuses)];
    if (deduped.length === 0) throw new Error('statuses must not be empty');
    return deduped;
  }
  if (options.includeHistorical) {
    return [SourceStatus.CURRENT, SourceStatus.SUPERSEDED];
  }
  return [SourceStatus.CURRENT];
}

function isHistorical(statuses: SourceStatus[]): boolean {
  return statuses.some((s) => s !== SourceStatus.CURRENT);
}

function isEligible(
  chunk: KnowledgeChunk,
  statuses: SourceStatus[],
  ceiling: Visibility,
  requester: RequesterContext | undefined,
  filters: ChunkFilters | undefined,
  deployedGitShas: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!statuses.includes(chunk.status)) return false;
  if (!isProductionEligible(chunk, deployedGitShas)) return false;
  // Visibility ceiling enforcement — before scoring, before the caller.
  const discloseOpts: { isSubject?: boolean; isStaff?: boolean } = {};
  if (requester?.isSubject !== undefined) discloseOpts.isSubject = requester.isSubject;
  if (requester?.isStaff !== undefined) discloseOpts.isStaff = requester.isStaff;
  if (!canDisclose(chunk.visibility, ceiling, discloseOpts)) {
    return false;
  }
  if (filters) {
    if (filters.sourceType !== undefined && chunk.sourceType !== filters.sourceType) return false;
    if (filters.component !== undefined && chunk.component !== filters.component) return false;
    if (filters.visibility !== undefined && chunk.visibility !== filters.visibility) return false;
    if (filters.version !== undefined && chunk.version !== filters.version) return false;
    if (filters.authority !== undefined && chunk.authority !== filters.authority) return false;
    if (filters.artifactId !== undefined && chunk.artifactId !== filters.artifactId) return false;
    if (filters.sourceLocator !== undefined && chunk.sourceLocator !== filters.sourceLocator) return false;
  }
  return true;
}

function productionShas(
  production: SearchOptions['production'],
): Readonly<Record<string, string>> | undefined {
  if (production === undefined) return undefined;
  const shas = production?.deployedGitShas;
  if (!shas || typeof shas !== 'object' || Array.isArray(shas)) {
    throw new Error('production search requires deployedGitShas evidence');
  }
  return shas;
}

function isProductionEligible(
  chunk: KnowledgeChunk,
  deployedGitShas: Readonly<Record<string, string>> | undefined,
): boolean {
  if (deployedGitShas === undefined || chunk.sourceType !== SourceType.GITHUB) {
    return true;
  }

  const commitSha = metadataString(chunk.metadata, 'commitSha');
  if (commitSha === undefined) return false;

  const deployedSha = deployedGitShas[chunk.authority]?.trim();
  if (!deployedSha) return false;

  return commitSha.trim().toLowerCase() === deployedSha.toLowerCase();
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function chunkMetadata(
  artifact: SourceArtifact,
  heading: string | undefined,
): Record<string, unknown> | undefined {
  // Copy only the provenance fields required for retrieval. Parser extras
  // may contain large or unsuitable values that should not be replicated.
  const metadata: Record<string, unknown> = {
    sourceObservedTime: artifact.observedTime,
    sourceIndexedTime: artifact.indexedTime,
  };
  if (artifact.sourceType === SourceType.GITHUB) {
    for (const field of ['branch', 'commitSha', 'deploymentState', 'blobSha']) {
      const value = metadataString(artifact.contentMetadata?.extra, field);
      if (value !== undefined) metadata[field] = value;
    }
  }
  if (artifact.contentMetadata?.contentType !== undefined) {
    metadata.contentType = artifact.contentMetadata.contentType;
  }
  if (artifact.parserVersion !== undefined) metadata.parserVersion = artifact.parserVersion;
  if (heading !== undefined) metadata.heading = heading;

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 10;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** Defense in depth: secrets are never indexed into model-visible storage. */
function assertIndexableChunk(chunk: KnowledgeChunk): void {
  if (chunk.visibility === Visibility.SECRET_DENY) {
    throw new Error(
      `refusing to index SECRET_DENY chunk ${chunk.chunkId}: secrets must never enter model-visible storage`,
    );
  }
  if (!chunk.chunkId || !chunk.artifactId || !chunk.text) {
    throw new Error('chunk requires chunkId, artifactId, and non-empty text');
  }
}

function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  return Math.max(1, Math.ceil(words * 1.3));
}
