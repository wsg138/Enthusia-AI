/**
 * @enthusia/knowledge-indexer — chunk persistence.
 *
 * MVP storage: SQLite (better-sqlite3), mirroring the W04 source-registry
 * storage choice. Portable schema (TEXT ISO-8601 timestamps) so a future
 * MySQL/MariaDB port is mechanical, per spec §9.4 direction.
 *
 * This store persists chunk text + metadata. Vectors live in the
 * `VectorStore` backend (in-memory for MVP, Qdrant later); the engine
 * rehydrates vectors from chunk text on startup when needed.
 */

import Database from 'better-sqlite3';
import { SourceStatus, SourceType, Visibility } from '@enthusia/contracts';
import type { KnowledgeChunk } from './types.js';

/**
 * Persistent chunk storage. The retrieval engine uses this as the
 * authoritative chunk record; search backends (vector/lexical) are
 * rebuildable indexes over it.
 */
export interface ChunkStore {
  saveChunks(chunks: KnowledgeChunk[]): void;
  getChunk(chunkId: string): KnowledgeChunk | undefined;
  listByArtifact(artifactId: string): KnowledgeChunk[];
  listAll(): KnowledgeChunk[];
  /** Update the status snapshot for every chunk of an artifact (supersession path). */
  updateStatusByArtifact(artifactId: string, status: SourceStatus): number;
  deleteByArtifact(artifactId: string): number;
  count(): number;
  clear(): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id       TEXT PRIMARY KEY,
  artifact_id    TEXT NOT NULL,
  version        TEXT NOT NULL,
  status         TEXT NOT NULL,
  visibility     TEXT NOT NULL,
  source_type    TEXT NOT NULL,
  component      TEXT NOT NULL,
  authority      TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  chunk_index    INTEGER NOT NULL,
  text           TEXT NOT NULL,
  token_count    INTEGER,
  embedding_version TEXT,
  metadata_json  TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_artifact ON chunks(artifact_id);
CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(status);
`;

interface ChunkRow {
  chunk_id: string;
  artifact_id: string;
  version: string;
  status: string;
  visibility: string;
  source_type: string;
  component: string;
  authority: string;
  source_locator: string;
  chunk_index: number;
  text: string;
  token_count: number | null;
  embedding_version: string | null;
  metadata_json: string | null;
}

function rowToChunk(row: ChunkRow): KnowledgeChunk {
  const chunk: KnowledgeChunk = {
    chunkId: row.chunk_id,
    artifactId: row.artifact_id,
    version: row.version,
    status: row.status as SourceStatus,
    visibility: row.visibility as Visibility,
    sourceType: row.source_type as SourceType,
    component: row.component,
    authority: row.authority,
    sourceLocator: row.source_locator,
    text: row.text,
    chunkIndex: row.chunk_index,
  };
  if (row.token_count !== null) chunk.tokenCount = row.token_count;
  if (row.embedding_version !== null) chunk.embeddingVersion = row.embedding_version;
  if (row.metadata_json !== null) {
    chunk.metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  }
  return chunk;
}

/** SQLite-backed chunk store (better-sqlite3, synchronous). */
export class SqliteChunkStore implements ChunkStore {
  private readonly db: Database.Database;
  private closed = false;

  /**
   * @param path Filesystem path, or ':memory:' for an ephemeral store.
   */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SqliteChunkStore is closed');
  }

  saveChunks(chunks: KnowledgeChunk[]): void {
    this.assertOpen();
    const stmt = this.db.prepare(`
      INSERT INTO chunks (
        chunk_id, artifact_id, version, status, visibility, source_type,
        component, authority, source_locator, chunk_index, text,
        token_count, embedding_version, metadata_json, created_at
      ) VALUES (
        @chunkId, @artifactId, @version, @status, @visibility, @sourceType,
        @component, @authority, @sourceLocator, @chunkIndex, @text,
        @tokenCount, @embeddingVersion, @metadataJson, @createdAt
      )
      ON CONFLICT(chunk_id) DO UPDATE SET
        artifact_id = excluded.artifact_id,
        version = excluded.version,
        status = excluded.status,
        visibility = excluded.visibility,
        source_type = excluded.source_type,
        component = excluded.component,
        authority = excluded.authority,
        source_locator = excluded.source_locator,
        chunk_index = excluded.chunk_index,
        text = excluded.text,
        token_count = excluded.token_count,
        embedding_version = excluded.embedding_version,
        metadata_json = excluded.metadata_json
    `);
    const now = new Date().toISOString();
    const save = this.db.transaction((items: KnowledgeChunk[]) => {
      for (const c of items) {
        stmt.run({
          chunkId: c.chunkId,
          artifactId: c.artifactId,
          version: c.version,
          status: c.status,
          visibility: c.visibility,
          sourceType: c.sourceType,
          component: c.component,
          authority: c.authority,
          sourceLocator: c.sourceLocator,
          chunkIndex: c.chunkIndex,
          text: c.text,
          tokenCount: c.tokenCount ?? null,
          embeddingVersion: c.embeddingVersion ?? null,
          metadataJson: c.metadata ? JSON.stringify(c.metadata) : null,
          createdAt: now,
        });
      }
    });
    save(chunks);
  }

  getChunk(chunkId: string): KnowledgeChunk | undefined {
    this.assertOpen();
    const row = this.db.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get(chunkId) as ChunkRow | undefined;
    return row ? rowToChunk(row) : undefined;
  }

  listByArtifact(artifactId: string): KnowledgeChunk[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM chunks WHERE artifact_id = ? ORDER BY chunk_index ASC')
      .all(artifactId) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  listAll(): KnowledgeChunk[] {
    this.assertOpen();
    const rows = this.db.prepare('SELECT * FROM chunks ORDER BY artifact_id, chunk_index').all() as ChunkRow[];
    return rows.map(rowToChunk);
  }

  updateStatusByArtifact(artifactId: string, status: SourceStatus): number {
    this.assertOpen();
    const info = this.db.prepare('UPDATE chunks SET status = ? WHERE artifact_id = ?').run(status, artifactId);
    return Number(info.changes);
  }

  deleteByArtifact(artifactId: string): number {
    this.assertOpen();
    const info = this.db.prepare('DELETE FROM chunks WHERE artifact_id = ?').run(artifactId);
    return Number(info.changes);
  }

  count(): number {
    this.assertOpen();
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    return row.n;
  }

  clear(): void {
    this.assertOpen();
    this.db.exec('DELETE FROM chunks');
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
