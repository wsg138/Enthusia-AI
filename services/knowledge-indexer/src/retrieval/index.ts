/**
 * @enthusia/knowledge-indexer — retrieval engine public API (W07).
 *
 * Hybrid (vector + lexical) evidence search with current-only default,
 * explicit historical opt-in, and visibility-ceiling enforcement.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 39;
 * MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §§13-15;
 * WORKER-EXECUTION-PLAN.md §10.
 */

export * from './types.js';
export * from './chunking.js';
export * from './embeddings.js';
export * from './vector-store.js';
export * from './lexical.js';
export * from './sqlite-store.js';
export * from './ranking.js';
export * from './engine.js';
