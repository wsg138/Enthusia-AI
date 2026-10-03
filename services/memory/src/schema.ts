/**
 * @enthusia/memory — SQLite schema (W05).
 *
 * Spec: MASTER-SPECIFICATION.md §49 (storage schema concept) and
 * MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §§2–5, 13–15, 21.
 *
 * The one-CURRENT-per-key invariant is enforced at the database level by a
 * partial unique index (`uq_current_revision_per_key`), so even concurrent
 * connections can never expose two CURRENT revisions for the same key.
 */

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS memory_keys (
  id          TEXT PRIMARY KEY,
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  scope       TEXT NOT NULL,
  visibility  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (namespace, key, scope)
);

CREATE TABLE IF NOT EXISTS memory_revisions (
  id                        TEXT PRIMARY KEY,
  memory_key_id             TEXT NOT NULL REFERENCES memory_keys(id),
  value_json                TEXT NOT NULL,
  summary                   TEXT NOT NULL,
  status                    TEXT NOT NULL,
  valid_from                TEXT NOT NULL,
  valid_to                  TEXT,
  created_at                TEXT NOT NULL,
  verified_at               TEXT,
  authority                 TEXT NOT NULL,
  reason                    TEXT,
  -- Self-referential links are DEFERRABLE INITIALLY DEFERRED: supersession
  -- updates A.superseded_by -> B before B's row is inserted; the constraint
  -- is checked at COMMIT, when both rows exist. Never expose a half-link.
  supersedes_revision_id    TEXT REFERENCES memory_revisions(id) DEFERRABLE INITIALLY DEFERRED,
  superseded_by_revision_id TEXT REFERENCES memory_revisions(id) DEFERRABLE INITIALLY DEFERRED
);

-- Core invariant (§4 / §5): at most one CURRENT revision per memory key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_current_revision_per_key
  ON memory_revisions (memory_key_id)
  WHERE status = 'CURRENT';

CREATE INDEX IF NOT EXISTS ix_revisions_key_created
  ON memory_revisions (memory_key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_evidence (
  id                 TEXT PRIMARY KEY,
  revision_id        TEXT NOT NULL REFERENCES memory_revisions(id),
  source_artifact_id TEXT NOT NULL,
  source_version     TEXT NOT NULL,
  evidence_role      TEXT NOT NULL,
  observed_at        TEXT,
  verified_at        TEXT,
  authority_level    TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_evidence_revision
  ON memory_evidence (revision_id);

-- Materialized "current semantic index" (§5 steps 8–9, §15): only the CURRENT
-- revision of each key is indexed here. Supersession replaces the row; the
-- superseded revision is removed from this index but retained in history.
CREATE TABLE IF NOT EXISTS memory_current_index (
  memory_key_id TEXT PRIMARY KEY REFERENCES memory_keys(id),
  revision_id   TEXT NOT NULL REFERENCES memory_revisions(id),
  summary       TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Durable event stream (§21): memory.created, memory.verified,
-- memory.superseded, memory.invalidated, memory.conflicted, memory.restored.
CREATE TABLE IF NOT EXISTS memory_events (
  id            TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  memory_key_id TEXT NOT NULL REFERENCES memory_keys(id),
  revision_id   TEXT REFERENCES memory_revisions(id),
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_events_key_created
  ON memory_events (memory_key_id, created_at DESC);
`;
