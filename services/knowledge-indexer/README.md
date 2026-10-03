# @enthusia/knowledge-indexer

Bloom knowledge/indexing service — hybrid evidence search across indexed artifacts.

**W07** ships the retrieval engine (`src/retrieval/`). The source indexers
(GitHub, SFTP, …) land in **W08/W09** and drive this engine's indexing methods.

Spec: `MASTER-SPECIFICATION.md` §§12, 39;
`MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md` §§13–15;
`WORKER-EXECUTION-PLAN.md` §10.

## Non-negotiable invariants

1. **Current-only default.** `search()` returns `CURRENT` chunks only unless
   the caller explicitly opts into history (`includeHistorical: true` or an
   explicit `statuses` override). `SUPERSEDED` / `INVALID` / `STALE` are never
   normal answer candidates. Historical hits are flagged `historical: true`
   so callers can apply temporal framing (§14).
2. **Visibility before results.** `visibilityCeiling` is required and enforced
   with `canDisclose` *before* scoring — the caller never sees an ineligible
   chunk. `SECRET_DENY` chunks are rejected at index time.
3. **Metadata-driven status.** Supersession propagates via
   `updateArtifactStatus` (no re-index); the current-only filter never relies
   on text labels (§15).

## Layout

| File | Owns |
|---|---|
| `src/retrieval/types.ts` | `KnowledgeChunk`, `SearchOptions`, `RetrievalHit`, provenance |
| `src/retrieval/chunking.ts` | `Chunker` interface, `FixedWindowChunker`, `MarkdownSectionChunker` |
| `src/retrieval/embeddings.ts` | `EmbeddingProvider` interface, deterministic test-only hashing provider |
| `src/retrieval/vector-store.ts` | `VectorStore` interface (Qdrant plugs in here later), in-memory backend |
| `src/retrieval/lexical.ts` | `LexicalIndex` interface, BM25-lite + verbatim §39 identifier matching |
| `src/retrieval/sqlite-store.ts` | `ChunkStore` interface, SQLite persistence (better-sqlite3) |
| `src/retrieval/ranking.ts` | `HybridRanker`: weighted normalized vector + lexical scores |
| `src/retrieval/engine.ts` | `KnowledgeRetrievalEngine`: `search`, `indexChunks`, `indexArtifactText`, `updateArtifactStatus`, `removeArtifact`, `rebuildIndexes` |

## §39 identifier handling

Vector similarity alone is insufficient for command names, permission nodes,
exact config keys, player UUIDs, and version strings. The lexical index
extracts these verbatim (`/staff`, `enthusia.staff.freeze`, UUIDs, `1.21.4`)
and adds an exact-match bonus; `exactMatch: true` is reported on hits.

## MVP vs production

- Embeddings: deterministic hashing provider (**test-only**, captures token
  overlap, not semantics). A real model implements `EmbeddingProvider` later;
  `embeddingVersion` on chunks detects stale vectors after a model swap.
- Vector search: in-memory brute-force cosine. `VectorStore` is the seam for
  Qdrant — callers program against the interface only.
- Storage: SQLite chunk persistence; search indexes rebuild from it on startup
  via `rebuildIndexes()`.

## Tests

`test/retrieval.test.ts` — 41 tests: chunking, vector store, lexical/exact
search, hybrid ranking, current-only default, historical opt-in, visibility
enforcement, metadata filters, provenance/version, SQLite persistence.
