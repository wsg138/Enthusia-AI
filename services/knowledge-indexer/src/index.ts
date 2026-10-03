/**
 * @enthusia/knowledge-indexer — Bloom knowledge/indexing service.
 *
 * W07 ships the retrieval engine (`./retrieval`): hybrid vector + lexical
 * search with current-only default, explicit historical opt-in, and
 * visibility-ceiling enforcement. The source indexers (GitHub, SFTP, ...)
 * land in W08/W09 and drive this engine's indexing methods.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 39; WORKER-EXECUTION-PLAN.md §10.
 */

export * as retrieval from './retrieval/index.js';
