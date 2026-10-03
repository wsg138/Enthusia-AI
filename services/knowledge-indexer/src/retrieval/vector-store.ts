/**
 * @enthusia/knowledge-indexer — vector store abstraction.
 *
 * `VectorStore` is the seam where Qdrant (or another ANN engine) plugs in
 * later. Callers — including the retrieval engine — program against this
 * interface only, so swapping the backend changes no call sites.
 *
 * Spec: WORKER-EXECUTION-PLAN.md §10 (W07 owns vector search; Qdrant later).
 */

export interface VectorHit {
  /** Chunk ID. */
  id: string;
  /** Similarity score, 0..1 (cosine for the in-memory backend). */
  score: number;
}

export interface VectorEntry {
  id: string;
  vector: number[];
}

/**
 * Vector similarity backend.
 *
 * Notes for implementors:
 * - `search` must apply `idFilter` BEFORE scoring (visibility and
 *   current-only filters are enforced pre-search, never post-hoc).
 * - Scores must be normalized to 0..1 so the hybrid ranker can combine
 *   them with lexical scores.
 * - `upsert` replaces any existing entry with the same id (re-index path).
 */
export interface VectorStore {
  /** Backend label, e.g. 'in-memory' or 'qdrant'. Recorded for debugging. */
  readonly name: string;
  /** Expected vector dimension. */
  readonly dimension: number;
  /** Insert or replace entries. */
  upsert(entries: VectorEntry[]): Promise<void>;
  /**
   * Top-`topK` most similar entries to `query`.
   * `idFilter`, when given, restricts the candidate set before scoring.
   */
  search(query: number[], topK: number, idFilter?: (id: string) => boolean): Promise<VectorHit[]>;
  /** Remove entries by id. Unknown ids are ignored. */
  remove(ids: string[]): Promise<void>;
  /** Remove all entries. */
  clear(): Promise<void>;
  /** Number of stored entries. */
  count(): Promise<number>;
}

/** Cosine similarity for L2-normalized vectors (dot product). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  // Clamp for floating-point safety; normalized vectors yield [0, 1]
  // for the non-negative-similarity use here.
  return Math.min(1, Math.max(0, dot));
}

/**
 * In-memory brute-force vector store.
 *
 * MVP backend: exact cosine scan over all entries. Correct and
 * deterministic; replaced by Qdrant (ANN) when the corpus outgrows memory.
 */
export class InMemoryVectorStore implements VectorStore {
  readonly name = 'in-memory';
  readonly dimension: number;
  private readonly entries = new Map<string, number[]>();

  constructor(dimension: number) {
    if (dimension <= 0) throw new Error('dimension must be positive');
    this.dimension = dimension;
  }

  async upsert(entries: VectorEntry[]): Promise<void> {
    for (const e of entries) {
      if (e.vector.length !== this.dimension) {
        throw new Error(
          `vector dimension mismatch for ${e.id}: expected ${this.dimension}, got ${e.vector.length}`,
        );
      }
      this.entries.set(e.id, [...e.vector]);
    }
  }

  async search(query: number[], topK: number, idFilter?: (id: string) => boolean): Promise<VectorHit[]> {
    if (query.length !== this.dimension) {
      throw new Error(`query dimension mismatch: expected ${this.dimension}, got ${query.length}`);
    }
    if (topK <= 0) return [];
    const hits: VectorHit[] = [];
    for (const [id, vector] of this.entries) {
      if (idFilter && !idFilter(id)) continue;
      hits.push({ id, score: cosineSimilarity(query, vector) });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, topK);
  }

  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.entries.delete(id);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  async count(): Promise<number> {
    return this.entries.size;
  }
}
