/**
 * @enthusia/integration-sftp — indexer tests (W09).
 *
 * Uses MockSftpServer (no real connections), FakeRegistry (W04 lifecycle),
 * and FakeRetrieval (W07 chunk/status semantics). Covers the acceptance
 * criteria:
 *
 * - changed config detected (hash change -> re-index, old artifact
 *   SUPERSEDED, chunks flipped, new chunks CURRENT);
 * - unchanged files skipped (no re-read, no re-index);
 * - denied paths never read through the indexer;
 * - deleted files marked INVALID with chunks leaving current retrieval;
 * - binary / secret-content / oversized files never indexed;
 * - per-file errors do not abort the scan;
 * - reconciler runs scans on schedule, single-flight, fail-soft.
 */

import { describe, expect, it } from 'vitest';
import { SourceStatus, SourceType, Visibility } from '@enthusia/contracts';
import { SftpIndexer, buildSftpLocator } from '../src/indexer.js';
import { SftpReconciler } from '../src/reconciler.js';
import { compileConfig } from '../src/config.js';
import { DenyGuardSftpClient } from '../src/sftp-client.js';
import { FakeRegistry, FakeRetrieval, MockSftpServer } from './fakes.js';

const SERVER = 'smp';

function makeTree(): MockSftpServer {
  const server = new MockSftpServer();
  server.writeFile('/srv/smp/plugins/Essentials/config.yml', 'debug: false\nops-name-color: "4"\n', 1_000);
  server.writeFile('/srv/smp/plugins/Essentials/messages.properties', 'welcome=hi\n', 1_000);
  server.writeFile('/srv/smp/logs/latest.log', '[INFO] done\n', 1_000);
  // Denied material present on the "server" must never be touched.
  server.writeFile('/srv/smp/.env', 'DB_PASSWORD=hunter2\n', 1_000);
  server.writeFile('/srv/smp/plugins/Auth/credentials.yml', 'api: xyz\n', 1_000);
  server.writeFile('/srv/smp/plugins/Backup/token-cache.json', '{"t":"abc"}\n', 1_000);
  server.writeFile('/srv/smp/keys/id_rsa', 'fake-key\n', 1_000);
  return server;
}

function makeIndexer(
  server: MockSftpServer,
  opts: { includeExtensions?: string[]; maxFileBytes?: number; maxDepth?: number } = {},
) {
  const registry = new FakeRegistry();
  const retrieval = new FakeRetrieval();
  // NOTE: the raw mock is passed in — the indexer wraps it in a deny guard
  // itself. Tests assert the guard is effective even though the caller did
  // not pre-guard.
  const indexer = new SftpIndexer(
    SERVER,
    [
      {
        path: '/srv/smp',
        visibility: Visibility.STAFF,
        includeExtensions: opts.includeExtensions,
      },
    ],
    { client: server, registry, retrieval },
    { maxFileBytes: opts.maxFileBytes ?? 1024 * 1024, maxDepth: opts.maxDepth ?? 12 },
  );
  return { indexer, registry, retrieval, server };
}

describe('initial scan', () => {
  it('indexes allowed files and skips denied ones without touching them', async () => {
    const { indexer, registry, retrieval, server } = makeIndexer(makeTree());
    const result = await indexer.scan();

    expect(result.errors).toEqual([]);
    expect(result.indexedCreated).toBe(3);
    expect(result.skippedDenied).toBeGreaterThanOrEqual(4);

    const locators = registry.listCurrent().map((a) => a.sourceLocator);
    expect(locators).toContain(buildSftpLocator(SERVER, '/srv/smp/plugins/Essentials/config.yml'));
    expect(locators).toContain(buildSftpLocator(SERVER, '/srv/smp/logs/latest.log'));

    // Denied files: no artifacts, no chunks, never touched on the wire.
    expect(registry.listCurrent().some((a) => a.sourceLocator.includes('.env'))).toBe(false);
    expect(registry.listCurrent().some((a) => a.sourceLocator.includes('credentials'))).toBe(false);
    expect(server.touched('.env')).toBe(false);
    expect(server.touched('credentials.yml')).toBe(false);
    expect(server.touched('token-cache.json')).toBe(false);
    expect(server.touched('id_rsa')).toBe(false);

    // Chunks are indexed CURRENT with STAFF visibility.
    expect(retrieval.chunks.size).toBeGreaterThan(0);
    for (const chunk of retrieval.chunks.values()) {
      expect(chunk.status).toBe(SourceStatus.CURRENT);
      expect(chunk.visibility).toBe(Visibility.STAFF);
      expect(chunk.sourceType).toBe(SourceType.SFTP_FILE);
    }
  });

  it('records path/size/mtime metadata and sha256 versions', async () => {
    const { indexer, registry } = makeIndexer(makeTree());
    await indexer.scan();
    const artifact = registry.getCurrent(buildSftpLocator(SERVER, '/srv/smp/plugins/Essentials/config.yml'));
    expect(artifact).toBeDefined();
    expect(artifact?.version).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact?.contentMetadata?.sizeBytes).toBeGreaterThan(0);
    expect(artifact?.contentMetadata?.extra?.['mtimeMs']).toBe(1_000);
    expect(artifact?.contentMetadata?.extra?.['remotePath']).toBe('/srv/smp/plugins/Essentials/config.yml');
    expect(artifact?.parserVersion).toBe('sftp-w09/1.0.0');
    expect(artifact?.authority).toBe('deployed_config:smp');
  });

  it('respects maxDepth', async () => {
    const server = makeTree();
    server.writeFile('/srv/smp/a/b/c/deep.yml', 'x: 1\n', 1_000);
    const { indexer, registry } = makeIndexer(server, { maxDepth: 2 });
    await indexer.scan();
    expect(registry.getCurrent(buildSftpLocator(SERVER, '/srv/smp/a/b/c/deep.yml'))).toBeUndefined();
  });
});

describe('incremental indexing', () => {
  it('skips unchanged files without re-reading them', async () => {
    const { indexer, registry, server } = makeIndexer(makeTree());
    const first = await indexer.scan();
    expect(first.indexedCreated).toBe(3);

    server.operations.length = 0;
    const second = await indexer.scan();
    expect(second.errors).toEqual([]);
    expect(second.skippedUnchanged).toBe(3);
    expect(second.indexedCreated).toBe(0);
    expect(second.indexedSuperseded).toBe(0);
    // Correctness-first path: unchanged files are hashed but never re-read
    // for parsing/indexing.
    expect(server.count('readFile:')).toBe(0);
    expect(server.count('hashFile:')).toBeGreaterThan(0);
    expect(server.count('stat:')).toBeGreaterThan(0);
    expect(registry.listCurrent()).toHaveLength(3);
  });

  it('detects changed config: hash change -> re-index with supersession', async () => {
    const { indexer, registry, retrieval, server } = makeIndexer(makeTree());
    await indexer.scan();
    const locator = buildSftpLocator(SERVER, '/srv/smp/plugins/Essentials/config.yml');
    const before = registry.getCurrent(locator);
    expect(before).toBeDefined();
    const oldChunks = retrieval.chunksFor(before!.artifactId);
    expect(oldChunks.length).toBeGreaterThan(0);

    // Simulate a config edit: new content, new mtime.
    server.writeFile('/srv/smp/plugins/Essentials/config.yml', 'debug: true\nops-name-color: "4"\n', 2_000);
    const result = await indexer.scan();

    expect(result.errors).toEqual([]);
    expect(result.indexedSuperseded).toBe(1);
    expect(result.skippedUnchanged).toBe(2);

    const after = registry.getCurrent(locator);
    expect(after).toBeDefined();
    expect(after!.artifactId).not.toBe(before!.artifactId);
    expect(after!.version).not.toBe(before!.version);

    // W04 history: the old artifact is SUPERSEDED, not deleted.
    const oldRecord = registry.all().find((a) => a.artifactId === before!.artifactId);
    expect(oldRecord?.status).toBe(SourceStatus.SUPERSEDED);

    // W07 status propagation: old chunks flipped, new chunks CURRENT.
    for (const chunk of retrieval.chunksFor(before!.artifactId)) {
      expect(chunk.status).toBe(SourceStatus.SUPERSEDED);
    }
    const newChunks = retrieval.chunksFor(after!.artifactId);
    expect(newChunks.length).toBeGreaterThan(0);
    for (const chunk of newChunks) {
      expect(chunk.status).toBe(SourceStatus.CURRENT);
    }
    expect(newChunks.some((c) => c.text.includes('debug: true'))).toBe(true);
  });

  it('detects same-size content changes even when mtime is preserved', async () => {
    const { indexer, registry, server } = makeIndexer(makeTree());
    await indexer.scan();
    const locator = buildSftpLocator(SERVER, '/srv/smp/plugins/Essentials/config.yml');
    const before = registry.getCurrent(locator);
    const originalMtime = 1_000;
    server.writeFile('/srv/smp/plugins/Essentials/config.yml', 'debug: true \nops-name-color: "4"\n', originalMtime);
    const result = await indexer.scan();
    const after = registry.getCurrent(locator);
    expect(result.indexedSuperseded).toBe(1);
    expect(after?.artifactId).not.toBe(before?.artifactId);
  });

  it('same content with only mtime change is skipped after hash comparison', async () => {
    const { indexer, registry, server } = makeIndexer(makeTree());
    await indexer.scan();
    const locator = buildSftpLocator(SERVER, '/srv/smp/plugins/Essentials/config.yml');
    const before = registry.getCurrent(locator);

    // mtime bumped but bytes identical -> slow path hashes, finds same
    // version, skips without re-registering or re-chunking.
    server.touchMtime('/srv/smp/plugins/Essentials/config.yml', 9_999);
    server.operations.length = 0;
    const result = await indexer.scan();
    expect(result.skippedUnchanged).toBe(3);
    expect(result.indexedSuperseded).toBe(0);
    expect(server.count('hashFile:')).toBeGreaterThan(0);
    expect(server.count('readFile:')).toBe(0);
    expect(registry.getCurrent(locator)?.artifactId).toBe(before!.artifactId);
  });
});

describe('deletion handling', () => {
  it('marks deleted files INVALID and flips their chunks', async () => {
    const { indexer, registry, retrieval, server } = makeIndexer(makeTree());
    await indexer.scan();
    const locator = buildSftpLocator(SERVER, '/srv/smp/logs/latest.log');
    const artifact = registry.getCurrent(locator);
    expect(artifact).toBeDefined();

    server.deletePath('/srv/smp/logs/latest.log');
    const result = await indexer.scan();
    expect(result.invalidated).toBe(1);
    expect(registry.getCurrent(locator)).toBeUndefined();
    for (const chunk of retrieval.chunksFor(artifact!.artifactId)) {
      expect(chunk.status).toBe(SourceStatus.INVALID);
    }
  });
});

describe('content safety', () => {
  it('never indexes binary files', async () => {
    const server = makeTree();
    server.writeFile('/srv/smp/plugins/Essentials/data.bin', Buffer.from([0x00, 0x01, 0x02, 0xff]), 1_000);
    const { indexer, registry } = makeIndexer(server);
    const result = await indexer.scan();
    expect(result.skippedBinary).toBe(1);
    expect(
      registry.getCurrent(buildSftpLocator(SERVER, '/srv/smp/plugins/Essentials/data.bin')),
    ).toBeUndefined();
  });

  it('never indexes files whose content looks like a private key', async () => {
    const server = makeTree();
    server.writeFile(
      '/srv/smp/plugins/Essentials/notes.txt',
      'reminder\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----\n',
      1_000,
    );
    const { indexer, registry, retrieval } = makeIndexer(server);
    const result = await indexer.scan();
    expect(result.skippedSecretContent).toBe(1);
    const locator = buildSftpLocator(SERVER, '/srv/smp/plugins/Essentials/notes.txt');
    expect(registry.getCurrent(locator)).toBeUndefined();
    const artifactIds = new Set(registry.all().filter((a) => a.sourceLocator === locator).map((a) => a.artifactId));
    expect([...retrieval.chunks.values()].some((c) => artifactIds.has(c.artifactId))).toBe(false);
  });

  it('refuses credential-shaped content under an allowed filename', async () => {
    const server = makeTree();
    server.writeFile(
      '/srv/smp/plugins/Essentials/notes.txt',
      ['api_key = "', 'ghp_', 'abcdefghijklmnopqrstuvwx', '"'].join(''),
      1_000,
    );
    const { indexer, registry } = makeIndexer(server);
    const result = await indexer.scan();
    expect(result.skippedSecretContent).toBe(1);
    expect(registry.getCurrent(buildSftpLocator(SERVER, '/srv/smp/plugins/Essentials/notes.txt'))).toBeUndefined();
  });

  it('skips files larger than maxFileBytes', async () => {
    const server = makeTree();
    server.writeFile('/srv/smp/logs/huge.log', 'x'.repeat(10_000), 1_000);
    const { indexer, registry } = makeIndexer(server, { maxFileBytes: 100 });
    const result = await indexer.scan();
    // Oversize is an expected safety classification, not an operational error.
    expect(registry.getCurrent(buildSftpLocator(SERVER, '/srv/smp/logs/huge.log'))).toBeUndefined();
    expect(result.skippedOversized).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
    expect(result.indexedCreated).toBe(3);
  });
});

describe('extension allowlist', () => {
  it('only indexes configured extensions', async () => {
    const { indexer, registry } = makeIndexer(makeTree(), { includeExtensions: ['.yml'] });
    const result = await indexer.scan();
    expect(result.indexedCreated).toBe(1); // only config.yml; .properties/.log filtered, secrets denied
    expect(result.skippedFiltered).toBeGreaterThanOrEqual(2); // messages.properties + latest.log
    expect(
      registry.getCurrent(buildSftpLocator(SERVER, '/srv/smp/logs/latest.log')),
    ).toBeUndefined();
  });
});

describe('error isolation', () => {
  it('per-file errors do not abort the scan', async () => {
    const server = makeTree();
    server.deletePath('/srv/smp/logs/latest.log');
    // Re-create the directory entry as a dangling reference is hard with the
    // mock; instead poison stat by deleting between list and stat via a spy.
    const { indexer } = makeIndexer(server);
    const origStat = server.stat.bind(server);
    let poisoned = false;
    server.stat = async (p: string) => {
      if (!poisoned && p.endsWith('messages.properties')) {
        poisoned = true;
        throw new Error('EIO: simulated stat failure');
      }
      return origStat(p);
    };
    const result = await indexer.scan();
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('messages.properties');
    expect(result.indexedCreated).toBe(1); // only config.yml; latest.log was deleted pre-scan
  });
});

describe('freshness failure recovery', () => {
  it('stales current knowledge on an incomplete scan and revalidates after recovery', async () => {
    const server = makeTree();
    const { indexer, registry, retrieval } = makeIndexer(server);
    await indexer.scan();

    const locator = buildSftpLocator(SERVER, '/srv/smp/plugins/Essentials/config.yml');
    const artifact = registry.getCurrent(locator)!;
    expect(artifact.status).toBe(SourceStatus.CURRENT);

    const originalStat = server.stat.bind(server);
    let fail = true;
    server.stat = async (remotePath: string) => {
      if (fail && remotePath.endsWith('messages.properties')) {
        throw new Error('EIO: transient stat failure');
      }
      return originalStat(remotePath);
    };

    const failed = await indexer.scan();
    expect(failed.errors.length).toBeGreaterThan(0);
    expect(registry.getCurrent(locator)?.status).toBe(SourceStatus.STALE);
    expect(
      retrieval.chunksFor(artifact.artifactId).every((chunk) => chunk.status === SourceStatus.STALE),
    ).toBe(true);

    fail = false;
    const recovered = await indexer.scan();
    expect(recovered.errors).toEqual([]);
    expect(registry.getCurrent(locator)?.status).toBe(SourceStatus.CURRENT);
    expect(
      retrieval.chunksFor(artifact.artifactId).every((chunk) => chunk.status === SourceStatus.CURRENT),
    ).toBe(true);
  });

});

describe('root confinement', () => {
  it('blocks lexical traversal before touching the escaped target', async () => {
    const server = makeTree();
    server.writeFile('/srv/outside.txt', 'outside\n', 1_000);
    const guarded = await DenyGuardSftpClient.forRoot(server, '/srv/smp');
    await expect(guarded.readFile('/srv/smp/../outside.txt', 1024)).rejects.toMatchObject({
      name: 'SftpPathEscapeError',
    });
    expect(server.touched('readFile:/srv/outside.txt')).toBe(false);
  });

  it('blocks symlink escapes after realpath without reading the target', async () => {
    const server = makeTree();
    server.writeFile('/outside/public.txt', 'outside\n', 1_000);
    server.symlink('/srv/smp/plugins/escape.txt', '/outside/public.txt');
    const guarded = await DenyGuardSftpClient.forRoot(server, '/srv/smp');
    await expect(guarded.readFile('/srv/smp/plugins/escape.txt', 1024)).rejects.toMatchObject({
      name: 'SftpPathEscapeError',
    });
    expect(server.touched('readFile:/outside/public.txt')).toBe(false);
  });
});

describe('denied root', () => {
  it('a denied allowlisted root is refused without any listing', async () => {
    const server = makeTree();
    const registry = new FakeRegistry();
    const retrieval = new FakeRetrieval();
    const indexer = new SftpIndexer(
      SERVER,
      [{ path: '/srv/smp/secrets', visibility: Visibility.STAFF }],
      { client: DenyGuardSftpClient.denyOnly(server), registry, retrieval },
    );
    const result = await indexer.scan();
    expect(result.skippedDenied).toBe(1);
    expect(registry.listCurrent()).toHaveLength(0);
    expect(server.touched('/srv/smp/secrets')).toBe(false);
  });
});

describe('config validation', () => {
  it('compiles a valid config and rejects secrets-shaped fields', () => {
    const compiled = compileConfig({
      servers: [
        {
          id: 'smp',
          host: 'sftp.example.invalid',
          username: 'minecraft',
          authSource: 'secret-manager',
          authRef: 'enthusia/sftp/smp-key',
          roots: [
            { path: '/home/minecraft/smp/plugins' },
            { path: '/home/minecraft/smp/logs', visibility: 'PUBLIC' },
          ],
        },
      ],
      maxFileBytes: 1024,
      reconcileIntervalMs: 60_000,
    });
    expect(compiled.config.servers[0]?.roots[0]?.visibility).toBe(Visibility.STAFF);
    expect(compiled.config.servers[0]?.port).toBe(22);
  });

  it('rejects unknown keys (no smuggled credentials)', () => {
    expect(() =>
      compileConfig({
        servers: [
          {
            id: 'smp',
            host: 'x',
            username: 'u',
            authRef: 'r',
            password: 'hunter2', // not in schema
            roots: [{ path: '/x' }],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects relative root paths and bad server ids', () => {
    expect(() =>
      compileConfig({
        servers: [{ id: 'SMP!', host: 'x', username: 'u', authRef: 'r', roots: [{ path: '/x' }] }],
      }),
    ).toThrow();
    expect(() =>
      compileConfig({
        servers: [{ id: 'smp', host: 'x', username: 'u', authRef: 'r', roots: [{ path: 'relative' }] }],
      }),
    ).toThrow();
  });

  it('rejects duplicate server ids', () => {
    const one = { id: 'smp', host: 'x', username: 'u', authRef: 'r', roots: [{ path: '/x' }] };
    expect(() => compileConfig({ servers: [one, { ...one }] })).toThrow(/unique/);
  });
});

describe('SftpReconciler', () => {
  function makeCompiled(): ReturnType<typeof compileConfig> {
    return compileConfig({
      servers: [
        {
          id: 'smp',
          host: 'sftp.example.invalid',
          username: 'minecraft',
          authRef: 'ref',
          roots: [{ path: '/srv/smp' }],
        },
      ],
      reconcileIntervalMs: 60_000,
    });
  }

  it('runOnce scans every server and reports via onRun', async () => {
    const server = makeTree();
    const registry = new FakeRegistry();
    const retrieval = new FakeRetrieval();
    const seen: string[] = [];
    const reconciler = new SftpReconciler(
      makeCompiled(),
      async () => server,
      () => ({ registry, retrieval }),
      {
        intervalMs: 60_000,
        jitterMs: 0,
        callbacks: { onRun: (s) => seen.push(s.serverId) },
      },
    );
    await reconciler.runOnce();
    expect(seen).toEqual(['smp']);
    expect(registry.listCurrent()).toHaveLength(3);
    const state = reconciler.getState();
    expect(state.runsTotal).toBe(1);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastSuccessAt).toBeDefined();
  });

  it('is fail-soft: a failed run records the error and the schedule survives', async () => {
    const errors: string[] = [];
    const reconciler = new SftpReconciler(
      makeCompiled(),
      async () => {
        throw new Error('ECONNREFUSED (simulated)');
      },
      () => ({ registry: new FakeRegistry(), retrieval: new FakeRetrieval() }),
      {
        intervalMs: 60_000,
        jitterMs: 0,
        callbacks: { onError: (_id, err) => errors.push(err.message) },
      },
    );
    await reconciler.runOnce();
    expect(errors).toEqual(['ECONNREFUSED (simulated)']);
    const state = reconciler.getState();
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastError).toBe('ECONNREFUSED (simulated)');
    // Second failure increments; a later success resets.
    await reconciler.runOnce();
    expect(reconciler.getState().consecutiveFailures).toBe(2);
  });

  it('rejects non-positive intervals', () => {
    expect(
      () =>
        new SftpReconciler(makeCompiled(), async () => makeTree(), () => ({
          registry: new FakeRegistry(),
          retrieval: new FakeRetrieval(),
        }), { intervalMs: 0 }),
    ).toThrow(/positive/);
  });
});

describe('deny enforcement through the indexer (defense in depth)', () => {
  it('a denied file added between list and stat is still refused', async () => {
    const server = makeTree();
    const { indexer, registry } = makeIndexer(server);
    // Sneak a denied file into the tree after the first scan indexed everything.
    await indexer.scan();
    server.writeFile('/srv/smp/plugins/Essentials/token-backup.json', '{"t":"x"}\n', 2_000);
    const result = await indexer.scan();
    expect(
      registry.getCurrent(buildSftpLocator(SERVER, '/srv/smp/plugins/Essentials/token-backup.json')),
    ).toBeUndefined();
    expect(server.touched('token-backup.json')).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('SecretDenyError from the guard is counted, never silently swallowed', async () => {
    const server = makeTree();
    const registry = new FakeRegistry();
    const retrieval = new FakeRetrieval();
    // Deliberately pass an UNGUARDED client: the indexer wraps it per root.
    // Then point a root at a denied path and assert the guard still fires.
    const indexer = new SftpIndexer(
      SERVER,
      [{ path: '/srv/smp', visibility: Visibility.STAFF }],
      { client: server, registry, retrieval },
    );
    server.writeFile('/srv/smp/deep/.ssh/notes.txt', 'x\n', 1_000);
    const result = await indexer.scan();
    expect(result.skippedDenied).toBeGreaterThanOrEqual(1);
    expect(registry.listCurrent().some((a) => a.sourceLocator.includes('.ssh'))).toBe(false);
  });
});
