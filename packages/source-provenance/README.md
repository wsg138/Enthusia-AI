# @enthusia/source-provenance

Source registry and provenance for Enthusia AI — the canonical model for
where facts came from. (Workstream W04.)

Spec: `MASTER-SPECIFICATION.md` §§12, 17, 30, 50, 54;
`MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md` §§2.1, 4, 10.
Contract types (`SourceArtifact`, `SourceType`, `SourceStatus`, `Visibility`)
come from `@enthusia/contracts`.

## Concepts

**Source locator** — the version-independent identity of a source, e.g.
`github:wsg138/EnthusiaStaff:config.yml`. It is the key the registry uses to
decide which artifact is current for that source. The version/hash lives on
the artifact, never in the locator. Builders and parsers live in
`src/locator.ts`; one canonical scheme per `SourceType`.

**Version/hash semantics** (`src/version.ts`) — a version is an opaque string
observed at indexing time (Git SHA, blob SHA, file/content hash, config
checksum, document version, DB revision, deployment version). An artifact is
valid while its version matches the live source's version. Any difference in
the *normalized* version (trimmed; hex fingerprints case-folded) constitutes
a change — the registry detects change, it does not rank versions.
`computeContentHash` (SHA-256) produces canonical fingerprints for
byte-addressable sources (SFTP files, configs, documents) per §12.2.

**Lifecycle** (`src/lifecycle.ts`) — artifacts move through the contract
`SourceStatus` states:

- `CURRENT` → `SUPERSEDED` when a new version of the same locator registers;
- `CURRENT` → `INVALID` when the source is deleted or untrustworthy
  (`INVALID` is terminal);
- `CURRENT` → `STALE` when the version can no longer be proven current;
  `STALE` → `CURRENT` on revalidation;
- `CURRENT` → `CONFLICTED` when authoritative evidence disagrees and no
  precedence rule resolves it; `CONFLICTED` → `CURRENT` on resolution;
- `SUPERSEDED` is historical forever — it can be invalidated but never
  becomes current again (history is not rewritten).

Invariants: exactly one latest artifact per locator; supersession is atomic
(old → `SUPERSEDED`, new → `CURRENT` in one transaction); re-registering an
unchanged version is a no-op (§12.2: "when the fingerprint is unchanged, keep
the current index").

**Visibility assignment** (`src/visibility.ts`, spec §17) — registration
requires an explicit visibility or an explicit opt-in to the conservative
per-source-type default (never `PUBLIC` by default). `SECRET_DENY` is
rejected at registration time: per §17.6 it is never indexed into
model-visible storage. Queries support exact-visibility filtering and
disclosure-ceiling filtering via the contract's `canDisclose`.

**Authority levels** (`src/authority.ts`, spec §30) — the contract's
free-form `authority` string is ranked
live-service > owner > deployment > git-deployed > staff > unknown >
historical > generated, so conflicts between artifacts can be resolved
deterministically. Ties at the top are reported as conflicts, never
silently picked.

## Usage

```ts
import { SourceProvenanceStore, SourceRegistry, buildLocator } from '@enthusia/source-provenance';
import { SourceType, Visibility } from '@enthusia/contracts';

const registry = new SourceRegistry(
  new SourceProvenanceStore({ path: './data/source-provenance.sqlite' }),
);

const locator = buildLocator(SourceType.GITHUB, 'wsg138/EnthusiaStaff', 'config.yml');

const created = registry.register({
  sourceType: SourceType.GITHUB,
  sourceLocator: locator,
  component: 'knowledge-indexer',
  authority: 'github:wsg138/EnthusiaStaff',
  version: '<commit-sha>',
  visibility: Visibility.STAFF,
});
// created.outcome === 'CREATED', artifact.status === 'CURRENT'

// Later: the file changed (new hash) -> atomic supersession.
const updated = registry.register({ /* same locator */ version: '<new-sha>' });
// updated.outcome === 'SUPERSEDED'
// registry.getCurrent(locator) -> the new artifact (CURRENT)
// registry.history(locator)    -> [new (CURRENT), old (SUPERSEDED)]

registry.markInvalid(artifactId); // source deleted / untrustworthy
registry.markStale(artifactId);   // cannot prove current anymore
registry.revalidate(artifactId);  // verified against the live source again

registry.listCurrent({ sourceType: SourceType.CONFIG });
registry.listCurrent({ visibilityCeiling: Visibility.STAFF, isStaff: true });
```

## Storage

MVP storage is **SQLite** via `better-sqlite3`: file-based, no server
needed. The schema is migration-friendly — migrations are version-controlled
in `src/store.ts` and recorded in a `schema_migrations` table.

Per spec §9.4, the production direction is **MySQL/MariaDB**. The schema was
designed to make that port mechanical:

- `TEXT` ISO-8601 timestamps (no SQLite-only date functions);
- plain DDL with no SQLite-only constructs;
- all queries are simple CRUD with positional parameters;
- the registry depends only on the `SourceProvenanceStore` interface, so a
  MySQL-backed store can replace the SQLite one without touching registry
  logic.

Do not mix these tables into unrelated product schemas (§9.4).
