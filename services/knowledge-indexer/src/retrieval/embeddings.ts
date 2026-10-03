/**
 * @enthusia/knowledge-indexer — embedding provider abstraction.
 *
 * The retrieval engine depends only on this interface. The MVP ships a
 * deterministic hashing provider for tests; the production provider
 * (real embedding model, recorded via `embeddingVersion`) plugs in later
 * without changing callers. Qdrant/real-model integration is explicitly
 * out of scope for W07.
 */

export interface EmbeddingProvider {
  /** Stable provider name, e.g. 'hashing-test' or 'e5-large-v2'. */
  readonly name: string;
  /** Vector dimension produced by `embed`. */
  readonly dimension: number;
  /**
   * Model+version label recorded on indexed chunks (`embeddingVersion`),
   * so a model swap can invalidate stale vectors.
   */
  readonly version: string;
  /** Embed a batch of texts; returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * 32-bit FNV-1a hash, used for deterministic token bucketing.
 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Lowercase word tokens; shared with the lexical index's tokenizer. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}

export interface HashingEmbeddingProviderOptions {
  dimension?: number;
}

/**
 * Deterministic signed random-projection embedding over token hashes.
 *
 * TEST-ONLY. This is a stand-in so the hybrid retrieval pipeline,
 * ranking, and filters can be exercised without network access or a model
 * download. It captures lexical overlap, NOT semantic meaning — it must
 * never be used for production retrieval. Production embeddings come from
 * a real model via a future `EmbeddingProvider` implementation.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hashing-test';
  readonly dimension: number;
  readonly version: string;

  constructor(options: HashingEmbeddingProviderOptions = {}) {
    this.dimension = options.dimension ?? 256;
    if (this.dimension <= 0) throw new Error('dimension must be positive');
    this.version = `hashing-test-v1/dim${this.dimension}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    for (const token of tokenize(text)) {
      const h = fnv1a(token);
      const idx = h % this.dimension;
      // Deterministic sign from a second hash bit: signed projection
      // reduces collision bias vs. pure count bucketing.
      const sign = (fnv1a(token + '#s') & 1) === 0 ? 1 : -1;
      const current = vec[idx] ?? 0;
      vec[idx] = current + sign;
    }
    // L2-normalize so cosine similarity is a plain dot product.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}
