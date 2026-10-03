import { describe, expect, it, beforeEach } from 'vitest';
import { SourceStatus, SourceType, Visibility } from '@enthusia/contracts';
import { SourceProvenanceStore } from '../src/store.js';
import { SourceRegistry, deriveArtifactId, type RegisterArtifactInput } from '../src/registry.js';
import { buildLocator } from '../src/locator.js';
import { computeContentHash } from '../src/version.js';
import {
  ArtifactNotFoundError,
  InvalidLocatorError,
  InvalidTransitionError,
  SecretDenyRejectedError,
} from '../src/errors.js';

function makeRegistry(): { registry: SourceRegistry; store: SourceProvenanceStore } {
  const store = new SourceProvenanceStore({ path: ':memory:' });
  return { registry: new SourceRegistry(store), store };
}

function githubInput(overrides: Partial<RegisterArtifactInput> = {}): RegisterArtifactInput {
  return {
    sourceType: SourceType.GITHUB,
    sourceLocator: buildLocator(SourceType.GITHUB, 'wsg138/EnthusiaStaff', 'config.yml'),
    component: 'knowledge-indexer',
    authority: 'github:wsg138/EnthusiaStaff',
    version: 'a'.repeat(40),
    visibility: Visibility.STAFF,
    ...overrides,
  };
}

describe('register — CRUD', () => {
  let registry: SourceRegistry;
  beforeEach(() => {
    ({ registry } = makeRegistry());
  });

  it('registers a new source artifact as CURRENT', () => {
    const result = registry.register(githubInput());
    expect(result.outcome).toBe('CREATED');
    expect(result.artifact.status).toBe(SourceStatus.CURRENT);
    expect(result.artifact.current).toBe(true);
    expect(result.supersededArtifactId).toBeUndefined();
  });

  it('validates the artifact against the contract schema', () => {
    expect(() => registry.register(githubInput({ component: '' }))).toThrow();
  });

  it('rejects locators whose scheme mismatches the source type', () => {
    expect(() =>
      registry.register(
        githubInput({
          sourceType: SourceType.CONFIG,
          sourceLocator: buildLocator(SourceType.GITHUB, 'wsg138/X', 'y.yml'),
        }),
      ),
    ).toThrow(InvalidLocatorError);
  });

  it('rejects SECRET_DENY visibility (§17.6: never indexed)', () => {
    expect(() =>
      registry.register(githubInput({ visibility: Visibility.SECRET_DENY })),
    ).toThrow(SecretDenyRejectedError);
  });

  it('re-registering an unchanged version is a no-op (UNCHANGED)', () => {
    const first = registry.register(githubInput());
    const second = registry.register(githubInput());
    expect(second.outcome).toBe('UNCHANGED');
    expect(second.artifact.artifactId).toBe(first.artifact.artifactId);
    expect(registry.stats()[SourceStatus.CURRENT]).toBe(1);
  });

  it('a differently-cased hex version is NOT a change (no phantom supersession)', () => {
    const first = registry.register(githubInput({ version: 'A'.repeat(40) }));
    const second = registry.register(githubInput({ version: 'a'.repeat(40) }));
    expect(second.outcome).toBe('UNCHANGED');
    expect(second.artifact.artifactId).toBe(first.artifact.artifactId);
  });

  it('derives deterministic artifact ids from (locator, version)', () => {
    const locator = buildLocator(SourceType.CONFIG, 'smp', 'server.properties');
    const first = registry.register(githubInput({ sourceLocator: locator, sourceType: SourceType.CONFIG }));
    expect(first.artifact.artifactId).toBe(deriveArtifactId(locator, 'a'.repeat(40)));
  });
});

describe('register — acceptance: changed file produces new CURRENT, old stays historical', () => {
  it('a new content hash supersedes atomically; the previous artifact remains SUPERSEDED', () => {
    const { registry } = makeRegistry();
    const locator = buildLocator(SourceType.SFTP_FILE, 'smp', '/plugins/EnthusiaStaff/config.yml');

    // v1: the file as first observed.
    const v1 = registry.register({
      sourceType: SourceType.SFTP_FILE,
      sourceLocator: locator,
      component: 'sftp-indexer',
      authority: 'sftp:smp',
      version: computeContentHash('motd: hello'),
      visibility: Visibility.STAFF,
    });
    expect(v1.outcome).toBe('CREATED');
    expect(v1.artifact.status).toBe(SourceStatus.CURRENT);

    // v2: the file changed (new hash).
    const v2 = registry.register({
      sourceType: SourceType.SFTP_FILE,
      sourceLocator: locator,
      component: 'sftp-indexer',
      authority: 'sftp:smp',
      version: computeContentHash('motd: hello world'),
      visibility: Visibility.STAFF,
    });
    expect(v2.outcome).toBe('SUPERSEDED');
    expect(v2.supersededArtifactId).toBe(v1.artifact.artifactId);

    // The new artifact is CURRENT.
    expect(v2.artifact.status).toBe(SourceStatus.CURRENT);
    expect(v2.artifact.current).toBe(true);
    expect(registry.getCurrent(locator)?.artifactId).toBe(v2.artifact.artifactId);

    // The previous artifact remains as historical (SUPERSEDED, not current).
    const old = registry.getById(v1.artifact.artifactId);
    expect(old.status).toBe(SourceStatus.SUPERSEDED);
    expect(old.current).toBe(false);
    expect(old.supersededBy).toBe(v2.artifact.artifactId);

    // Exactly one CURRENT artifact exists for the locator.
    const history = registry.history(locator);
    expect(history).toHaveLength(2);
    expect(history[0]?.artifactId).toBe(v2.artifact.artifactId);
    expect(history[1]?.artifactId).toBe(v1.artifact.artifactId);
    expect(history.filter((a) => a.current)).toHaveLength(1);
  });

  it('supersession is atomic: a failed insert leaves the old CURRENT untouched', () => {
    const { registry, store } = makeRegistry();
    const input = githubInput();
    const v1 = registry.register(input);

    // Plant a row that collides with the PRIMARY KEY the next version's
    // artifact id would use, so the INSERT inside the supersession
    // transaction fails after the old row was already marked SUPERSEDED.
    const nextVersion = 'b'.repeat(40);
    const collidingId = deriveArtifactId(input.sourceLocator, nextVersion);
    store.db
      .prepare(
        `INSERT INTO source_artifacts (
           artifact_id, source_type, source_locator, component, visibility,
           authority, version, observed_time, indexed_time, status, is_current,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        collidingId,
        SourceType.DEPLOYMENT,
        buildLocator(SourceType.DEPLOYMENT, 'other', 'x'),
        'test',
        Visibility.STAFF,
        'test',
        nextVersion,
        new Date().toISOString(),
        new Date().toISOString(),
        SourceStatus.CURRENT,
        1,
        new Date().toISOString(),
        new Date().toISOString(),
      );

    expect(() => registry.register({ ...input, version: nextVersion })).toThrow();

    // Atomicity: the old artifact is STILL the current one, unchanged.
    const current = registry.getCurrent(input.sourceLocator);
    expect(current?.artifactId).toBe(v1.artifact.artifactId);
    expect(current?.status).toBe(SourceStatus.CURRENT);
    expect(current?.current).toBe(true);
    expect(current?.supersededBy).toBeUndefined();
  });
});

describe('lifecycle operations', () => {
  let registry: SourceRegistry;
  beforeEach(() => {
    ({ registry } = makeRegistry());
  });

  it('markInvalid moves an artifact to terminal INVALID and out of the current view', () => {
    const { artifact } = registry.register(githubInput());
    const invalid = registry.markInvalid(artifact.artifactId);
    expect(invalid.status).toBe(SourceStatus.INVALID);
    expect(invalid.current).toBe(false);
    expect(registry.getCurrent(artifact.sourceLocator)).toBeUndefined();
    expect(() => registry.markStale(artifact.artifactId)).toThrow(InvalidTransitionError);
  });

  it('markStale / revalidate round-trips a CURRENT artifact', () => {
    const { artifact } = registry.register(githubInput());
    const stale = registry.markStale(artifact.artifactId);
    expect(stale.status).toBe(SourceStatus.STALE);
    // STALE is still the latest indexed artifact for the locator...
    expect(stale.current).toBe(true);
    // ...but the stats show it is no longer a trusted CURRENT.
    expect(registry.stats()[SourceStatus.CURRENT]).toBe(0);
    const revalidated = registry.revalidate(artifact.artifactId);
    expect(revalidated.status).toBe(SourceStatus.CURRENT);
  });

  it('reportConflict / resolveConflict round-trips a CURRENT artifact', () => {
    const { artifact } = registry.register(githubInput());
    const conflicted = registry.reportConflict(artifact.artifactId);
    expect(conflicted.status).toBe(SourceStatus.CONFLICTED);
    const resolved = registry.resolveConflict(artifact.artifactId);
    expect(resolved.status).toBe(SourceStatus.CURRENT);
  });

  it('getById throws for unknown artifacts', () => {
    expect(() => registry.getById('art_doesnotexist')).toThrow(ArtifactNotFoundError);
  });

  it('updateMetadata corrects mutable fields without touching version or status', () => {
    const { artifact } = registry.register(githubInput());
    const updated = registry.updateMetadata(artifact.artifactId, {
      visibility: Visibility.MANAGEMENT,
      authority: 'owner:lincoln',
    });
    expect(updated.visibility).toBe(Visibility.MANAGEMENT);
    expect(updated.authority).toBe('owner:lincoln');
    expect(updated.version).toBe(artifact.version);
    expect(updated.status).toBe(SourceStatus.CURRENT);
  });

  it('updateMetadata rejects SECRET_DENY', () => {
    const { artifact } = registry.register(githubInput());
    expect(() =>
      registry.updateMetadata(artifact.artifactId, { visibility: Visibility.SECRET_DENY }),
    ).toThrow(SecretDenyRejectedError);
  });
});

describe('queries', () => {
  it('listCurrent filters by source type and component', () => {
    const { registry } = makeRegistry();
    registry.register(githubInput());
    registry.register(
      githubInput({
        sourceType: SourceType.CONFIG,
        sourceLocator: buildLocator(SourceType.CONFIG, 'smp', 'server.properties'),
        component: 'config-indexer',
        authority: 'sftp:smp',
        visibility: Visibility.PUBLIC,
      }),
    );

    expect(registry.listCurrent({ sourceType: SourceType.GITHUB })).toHaveLength(1);
    expect(registry.listCurrent({ component: 'config-indexer' })).toHaveLength(1);
    expect(registry.listCurrent()).toHaveLength(2);
  });

  it('listCurrent filters by exact visibility', () => {
    const { registry } = makeRegistry();
    registry.register(githubInput({ visibility: Visibility.PUBLIC }));
    registry.register(
      githubInput({
        sourceLocator: buildLocator(SourceType.GITHUB, 'wsg138/X', 'private.yml'),
        visibility: Visibility.MANAGEMENT,
      }),
    );
    expect(registry.listCurrent({ visibility: Visibility.PUBLIC })).toHaveLength(1);
  });

  it('listCurrent enforces a disclosure ceiling', () => {
    const { registry } = makeRegistry();
    registry.register(githubInput({ visibility: Visibility.PUBLIC }));
    registry.register(
      githubInput({
        sourceLocator: buildLocator(SourceType.GITHUB, 'wsg138/X', 'staff.yml'),
        visibility: Visibility.STAFF,
      }),
    );
    registry.register(
      githubInput({
        sourceLocator: buildLocator(SourceType.GITHUB, 'wsg138/X', 'mgmt.yml'),
        visibility: Visibility.MANAGEMENT,
      }),
    );

    const staffView = registry.listCurrent({ visibilityCeiling: Visibility.STAFF, isStaff: true });
    expect(staffView.map((a) => a.visibility).sort()).toEqual([
      Visibility.PUBLIC,
      Visibility.STAFF,
    ]);

    const publicView = registry.listCurrent({ visibilityCeiling: Visibility.PUBLIC });
    expect(publicView.map((a) => a.visibility)).toEqual([Visibility.PUBLIC]);
  });

  it('PLAYER_SELF artifacts need an identity check under a ceiling', () => {
    const { registry } = makeRegistry();
    registry.register(
      githubInput({
        sourceType: SourceType.TICKET,
        sourceLocator: buildLocator(SourceType.TICKET, 'ticketbot', 'T-1'),
        authority: 'ticket:ticketbot',
        visibility: Visibility.PLAYER_SELF,
      }),
    );
    expect(
      registry.listCurrent({ visibilityCeiling: Visibility.STAFF }),
    ).toHaveLength(0);
    expect(
      registry.listCurrent({ visibilityCeiling: Visibility.STAFF, isSubject: true }),
    ).toHaveLength(1);
    expect(
      registry.listCurrent({ visibilityCeiling: Visibility.STAFF, isStaff: true }),
    ).toHaveLength(1);
  });

  it('history returns newest-first, including superseded artifacts', () => {
    const { registry } = makeRegistry();
    const locator = buildLocator(SourceType.DOCUMENT, 'rules', 'server-rules');
    const base = {
      sourceType: SourceType.DOCUMENT,
      sourceLocator: locator,
      component: 'docs-indexer',
      authority: 'staff:docs-team',
      visibility: Visibility.PUBLIC,
    } as const;
    const v1 = registry.register({ ...base, version: 'rules-v1' });
    const v2 = registry.register({ ...base, version: 'rules-v2' });
    const v3 = registry.register({ ...base, version: 'rules-v3' });

    const history = registry.history(locator);
    expect(history.map((a) => a.artifactId)).toEqual([
      v3.artifact.artifactId,
      v2.artifact.artifactId,
      v1.artifact.artifactId,
    ]);
    expect(history.map((a) => a.status)).toEqual([
      SourceStatus.CURRENT,
      SourceStatus.SUPERSEDED,
      SourceStatus.SUPERSEDED,
    ]);
    expect(registry.history('document:rules:does-not-exist')).toEqual([]);
  });

  it('stats counts artifacts per status', () => {
    const { registry } = makeRegistry();
    const a = registry.register(githubInput());
    registry.register(githubInput({ version: 'b'.repeat(40) }));
    registry.markInvalid(a.artifact.artifactId);
    const stats = registry.stats();
    expect(stats[SourceStatus.CURRENT]).toBe(1);
    // markInvalid on a SUPERSEDED artifact keeps it out of the current view.
    expect(stats[SourceStatus.INVALID]).toBe(1);
    expect(stats[SourceStatus.SUPERSEDED]).toBe(0);
  });
});

describe('store', () => {
  it('runs versioned migrations and reports the schema version', () => {
    const store = new SourceProvenanceStore({ path: ':memory:' });
    expect(store.schemaVersion).toBeGreaterThan(0);
    const applied = store.db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string }>;
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]?.name).toMatch(/initial/);
    store.close();
  });
});
