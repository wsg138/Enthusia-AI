/**
 * @enthusia/knowledge-indexer — hybrid result ranking.
 *
 * Combines vector similarity and lexical scores into a single ranked list.
 * Each signal is min-max normalized over the candidate set (so a strong
 * lexical exact match can outrank a weak vector similarity and vice
 * versa), then combined with configurable weights. Exact §39 identifier
 * matches break near-ties in favor of the verbatim hit.
 *
 * Spec: MASTER-SPECIFICATION.md §39; WORKER-EXECUTION-PLAN.md §10.
 */

import type { RankWeights } from './types.js';
import { DEFAULT_RANK_WEIGHTS } from './types.js';

/** One candidate entering the ranker, with per-signal scores. */
export interface ScoredCandidate {
  chunkId: string;
  /** Cosine similarity 0..1, when vector search scored this candidate. */
  vectorScore?: number;
  /** Lexical score 0..1, when lexical search scored this candidate. */
  lexicalScore?: number;
  /** True when a verbatim §39 identifier matched. */
  exactMatch: boolean;
}

/** A candidate with its final combined score. */
export interface RankedCandidate extends ScoredCandidate {
  /** Combined hybrid score, normalized to 0..1. */
  score: number;
}

export interface HybridRankerOptions {
  weights?: RankWeights;
  /**
   * Tie-break bonus added for exact identifier matches, small enough to
   * never invert a decisive score gap. Default 0.05.
   */
  exactMatchTieBreak?: number;
}

/**
 * Weighted hybrid ranker: score = wV * norm(vector) + wL * norm(lexical).
 *
 * Normalization is per-signal min-max over the candidate set; a signal
 * present on only one candidate still spans the full 0..1 range for that
 * candidate. Candidates missing a signal score 0 on it.
 */
export class HybridRanker {
  private readonly weights: RankWeights;
  private readonly exactMatchTieBreak: number;

  constructor(options: HybridRankerOptions = {}) {
    const w = options.weights ?? DEFAULT_RANK_WEIGHTS;
    if (w.vector < 0 || w.lexical < 0 || w.vector + w.lexical <= 0) {
      throw new Error('rank weights must be non-negative with a positive sum');
    }
    this.weights = { ...w };
    this.exactMatchTieBreak = options.exactMatchTieBreak ?? 0.05;
  }

  rank(candidates: ScoredCandidate[], weightsOverride?: RankWeights): RankedCandidate[] {
    if (candidates.length === 0) return [];

    const weights = weightsOverride ?? this.weights;
    if (weights.vector < 0 || weights.lexical < 0 || weights.vector + weights.lexical <= 0) {
      throw new Error('rank weights must be non-negative with a positive sum');
    }

    const vecVals = candidates.map((c) => c.vectorScore ?? 0);
    const lexVals = candidates.map((c) => c.lexicalScore ?? 0);
    const vecNorm = normalize(vecVals);
    const lexNorm = normalize(lexVals);
    const wSum = weights.vector + weights.lexical;

    const ranked = candidates.map((c, i) => {
      const v = vecNorm[i] ?? 0;
      const l = lexNorm[i] ?? 0;
      let score = (weights.vector * v + weights.lexical * l) / wSum;
      if (c.exactMatch) score = Math.min(1, score + this.exactMatchTieBreak);
      return { ...c, score };
    });

    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.exactMatch) - Number(a.exactMatch) ||
        (a.chunkId < b.chunkId ? -1 : 1),
    );
    return ranked;
  }
}

/** Min-max normalize to 0..1; a constant positive input maps to all-ones. */
function normalize(values: number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min)) return values.map(() => 0);
  // Constant signal: every candidate matched equally — score 1 when the
  // constant is positive (a lone strong match must not score 0), else 0.
  if (max <= min) return values.map((v) => (v > 0 ? 1 : 0));
  return values.map((v) => (v - min) / (max - min));
}
