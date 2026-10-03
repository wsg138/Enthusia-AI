/**
 * @enthusia/source-provenance — SQLite storage.
 *
 * Spec: MASTER-SPECIFICATION.md §9.4 (durable metadata store).
 *
 * MVP storage is SQLite via better-sqlite3: file-based, no server needed.
 * The schema is deliberately portable — TEXT ISO-8601 timestamps, no
 * SQLite-only constructs — so a future migration to MySQL/MariaDB (the
 * spec's recommended production direction, §9.4) is a mechanical port.
 * Migrations are version-controlled and applied in order; the
 * `schema_migrations` table records what has run.
 */

import Database from 'better-sqlite3';
import type {
  ContentMetadata,
  SourceArtifact,
  SourceStatus,
  SourceType,
  Visibility,
} from '@enthusia/contracts';

/** A stored artifact: the contract shape plus registry lifecycle fields. */
export interface StoredSourceArtifact extends SourceArtifact {
  status: SourceStatus;
  /** artifactId of the replacement, when this artifact was superseded. */
  supersededBy?: string;
}

export interface SourceProvenanceStoreOptions {
  /**
   * SQLite database path. Use ':memory:' for tests/ephemeral use.
   * Parent directories must exist.
   */
  path: string;
  /** When false, the store opens read-only (migrations are skipped). */
  writable?: boolean;
}

interface Migration {
  version: number;
  name: string;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial source_artifacts schema',
    up: `
      CREATE TABLE IF NOT EXISTS source_artifacts (
        artifact_id     TEXT PRIMARY KEY,
        source_type     TEXT NOT NULL,
        source_locator  TEXT NOT NULL,
        component       TEXT NOT NULL,
        visibility      TEXT NOT NULL,
        authority       TEXT NOT NULL,
        version         TEXT NOT NULL,
        observed_time   TEXT NOT NULL,
        indexed_time    TEXT NOT NULL,
        status          TEXT NOT NULL,
        is_current      INTEGER NOT NULL DEFAULT 0,
        superseded_by   TEXT,
        content_metadata TEXT,
        parser_version  TEXT,
        embedding_version TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_locator
        ON source_artifacts(source_locator);
      CREATE INDEX IF NOT EXISTS idx_artifacts_locator_current
        ON source_artifacts(source_locator, is_current);
      CREATE INDEX IF NOT EXISTS idx_artifacts_type_status
        ON source_artifacts(source_type, status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_component_status
        ON source_artifacts(component, status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_visibility_status
        ON source_artifacts(visibility, status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_indexed_time
        ON source_artifacts(indexed_time);
    `,
  },
  {
    version: 2,
    name: 'enforce one latest artifact per source locator',
    up: `
      CREATE UNIQUE INDEX IF NOT EXISTS uq_artifacts_locator_latest
        ON source_artifacts(source_locator)
        WHERE is_current = 1;
    `,
  },
];

/** Latest schema version this code understands. */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** Raw row shape of the source_artifacts table. */
export interface ArtifactRow {
  artifact_id: string;
  source_type: string;
  source_locator: string;
  component: string;
  visibility: string;
  authority: string;
  version: string;
  observed_time: string;
  indexed_time: string;
  status: string;
  is_current: number;
  superseded_by: string | null;
  content_metadata: string | null;
  parser_version: string | null;
  embedding_version: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToArtifact(row: ArtifactRow): StoredSourceArtifact {
  const artifact: StoredSourceArtifact = {
    artifactId: row.artifact_id,
    sourceType: row.source_type as SourceType,
    sourceLocator: row.source_locator,
    component: row.component,
    visibility: row.visibility as Visibility,
    authority: row.authority,
    version: row.version,
    observedTime: row.observed_time,
    indexedTime: row.indexed_time,
    current: row.is_current === 1,
    status: row.status as SourceStatus,
  };
  if (row.content_metadata !== null) {
    artifact.contentMetadata = JSON.parse(row.content_metadata) as ContentMetadata;
  }
  if (row.parser_version !== null) artifact.parserVersion = row.parser_version;
  if (row.embedding_version !== null) artifact.embeddingVersion = row.embedding_version;
  if (row.superseded_by !== null) artifact.supersededBy = row.superseded_by;
  return artifact;
}

export class SourceProvenanceStore {
  private readonly database: Database.Database;
  private closed = false;

  constructor(options: SourceProvenanceStoreOptions) {
    const writable = options.writable ?? true;
    this.database = new Database(options.path, { readonly: !writable });
    if (writable) {
      this.applyMigrations();
    }
  }

  /** Raw database handle for advanced use (transactions are managed by the registry). */
  get db(): Database.Database {
    return this.database;
  }

  get schemaVersion(): number {
    const row = this.database
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
      .get() as { v: number };
    return row.v;
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      (
        this.database.prepare('SELECT version FROM schema_migrations').all() as Array<{
          version: number;
        }>
      ).map((r) => r.version),
    );
    const insert = this.database.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    );
    const runAll = this.database.transaction((pending: Migration[]) => {
      for (const migration of pending) {
        this.database.exec(migration.up);
        insert.run(migration.version, migration.name, new Date().toISOString());
      }
    });
    const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
    if (pending.length > 0) {
      runAll(pending);
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.database.close();
    }
  }
}
