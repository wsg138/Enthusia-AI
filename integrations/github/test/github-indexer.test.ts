/**
 * @enthusia/integration-github — unit tests (W08).
 *
 * All GitHub I/O goes through `MockGitHubApi` (fixture); all registry and
 * retrieval behavior goes through the in-test fakes that replicate the
 * W04/W07 contracts. NO real GitHub API calls anywhere in this file.
 */

import { describe, expect, it } from 'vitest';
import { SourceStatus, Visibility } from '@enthusia/contracts';
import { GitHubIndexer, DEPLOYMENT_STATE_GIT_MAIN } from '../src/indexer.js';
import { loadGitHubIndexerConfig } from '../src/config.js';
import type { ResolvedApprovedRepo } from '../src/config.js';
import { RestGitHubClient, GitHubApiError } from '../src/github-client.js';
import {
  classifyPath,
  extractSymbols,
  looksLikeSecret,
  parseManifest,
  parseSimpleYaml,
} from '../src/parsers.js';
import { FakeRegistry, FakeRetrieval, MockGitHubApi, type FixtureFile } from './fakes.js';

const PLUGIN_YML = `name: ExamplePlugin
version: 1.2.0
main: acme.ExamplePlugin
description: An example plugin
commands:
  fly:
    description: Toggle flight
    permission: example.fly
    usage: /fly
  heal:
    description: Heal yourself
permissions:
  example.fly:
    description: Allows flight
    default: op
  example.heal:
    description: Allows healing
    default: true
`;

const JAVA_SRC = `package acme;

import org.bukkit.plugin.java.JavaPlugin;

public class ExamplePlugin extends JavaPlugin {
    @Override
    public void onEnable() {
        getLogger().info("enabled");
    }

    public boolean onCommand(CommandSender sender, Command cmd, String label, String[] args) {
        return true;
    }
}
`;

const README_MD = `# ExamplePlugin

An example plugin for testing the indexer.
`;

const CONFIG_YML = `settings:
  debug: false
  motd: "Hello"
`;

function fixtureFiles(): FixtureFile[] {
  return [
    { path: 'README.md', sha: 'aaa111', content: README_MD },
    { path: 'plugin.yml', sha: 'bbb222', content: PLUGIN_YML },
    { path: 'src/main/java/acme/ExamplePlugin.java', sha: 'ccc333', content: JAVA_SRC },
    { path: 'config.yml', sha: 'ddd444', content: CONFIG_YML },
    // Skips:
    { path: 'assets/logo.png', sha: 'eee555', content: 'PNGDATA' },
    { path: '.env', sha: 'fff666', content: 'TOKEN=abc' },
    { path: 'secrets/leaked.txt', sha: 'ggg777', content: 'deploy key: ghp_abcdefghijklmnopqrstuvwx' },
  ];
}

function makeIndexer(client: MockGitHubApi, registry?: FakeRegistry, retrieval?: FakeRetrieval) {
  const reg = registry ?? new FakeRegistry();
  const ret = retrieval ?? new FakeRetrieval();
  const indexer = new GitHubIndexer(
    {
      token: 'test-token-never-real',
      repos: [{ owner: 'acme', repo: 'ExamplePlugin' }],
    },
    { client, registry: reg, retrieval: ret, clock: () => '2026-10-03T00:00:00.000Z' },
  );
  return { indexer, registry: reg, retrieval: ret };
}


function repoCfg(overrides: Partial<ResolvedApprovedRepo> = {}): ResolvedApprovedRepo {
  return {
    owner: 'acme',
    repo: 'ExamplePlugin',
    codeVisibility: Visibility.STAFF,
    docsVisibility: Visibility.STAFF,
    indexIssues: false,
    indexPullRequests: false,
    includePaths: [],
    excludePaths: [],
    ...overrides,
  };
}

describe('GitHubIndexer — initial index', () => {
  it('indexes docs, manifests, code, and configs; skips binary/env/secrets', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    const { indexer, registry, retrieval } = makeIndexer(client);

    const report = await indexer.indexRepo({
      owner: 'acme',
      repo: 'ExamplePlugin',
      codeVisibility: Visibility.STAFF,
      docsVisibility: Visibility.PUBLIC,
      indexIssues: false,
      indexPullRequests: false,
      includePaths: [],
      excludePaths: [],
    });

    expect(report.branch).toBe('main');
    expect(report.commitSha).toBe('commit-1');
    expect(report.repoUnchanged).toBe(false);
    expect(report.filesSeen).toBe(7);
    expect(report.filesIndexed).toBe(4);
    expect(report.filesSkipped).toBe(3);
    expect(report.artifactsCreated).toBe(5); // 4 files + relationship summary
    expect(report.errors).toEqual([]);

    const skipReasons = new Map(report.skipped.map((s) => [s.path, s.reason]));
    expect(skipReasons.get('assets/logo.png')).toBe('unsupported-kind');
    expect(skipReasons.get('.env')).toBe('unsupported-kind');
    expect(skipReasons.get('secrets/leaked.txt')).toBe('secret-suspect');

    // Every artifact is CURRENT with git-main provenance (never "production").
    for (const artifact of registry.all()) {
      expect(artifact.status).toBe(SourceStatus.CURRENT);
      const extra = artifact.contentMetadata?.extra as Record<string, unknown>;
      expect(extra['deploymentState']).toBe(DEPLOYMENT_STATE_GIT_MAIN);
      expect(extra['deploymentState']).not.toBe('production');
      expect(extra['commitSha']).toBe('commit-1');
      expect(extra['branch']).toBe('main');
    }

    // Docs get docsVisibility; code gets codeVisibility.
    const readme = registry.getCurrent('github:acme/ExamplePlugin:README.md');
    expect(readme?.visibility).toBe(Visibility.PUBLIC);
    const java = registry.getCurrent('github:acme/ExamplePlugin:src/main/java/acme/ExamplePlugin.java');
    expect(java?.visibility).toBe(Visibility.STAFF);

    // Chunks were indexed for every artifact.
    expect(retrieval.chunks.length).toBeGreaterThan(0);
    expect(report.chunksIndexed).toBe(retrieval.chunks.length);

    // Code chunks carry the extracted symbols for exact lookup.
    const javaChunks = retrieval.chunksForArtifact(java!.artifactId);
    expect(javaChunks.some((c) => c.text.includes('# symbols:'))).toBe(true);
    expect(javaChunks.some((c) => c.text.includes('ExamplePlugin'))).toBe(true);
  });

  it('derives the required entity relationships', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    const { indexer, registry } = makeIndexer(client);
    const report = await indexer.indexRepo({
      owner: 'acme',
      repo: 'ExamplePlugin',
      codeVisibility: Visibility.STAFF,
      docsVisibility: Visibility.STAFF,
      indexIssues: false,
      indexPullRequests: false,
      includePaths: [],
      excludePaths: [],
    });

    const byType = (t: string) => report.relationships.filter((r) => r.type === t);

    // repo -> plugin
    expect(byType('REPO_BUILDS_PLUGIN')).toEqual([
      expect.objectContaining({
        from: 'github:acme/ExamplePlugin',
        to: 'plugin:ExamplePlugin@1.2.0',
      }),
    ]);
    // plugin -> commands
    const commands = byType('PLUGIN_DEFINES_COMMAND');
    expect(commands.map((r) => r.to).sort()).toEqual(['command:/fly', 'command:/heal']);
    // command -> permission
    expect(byType('COMMAND_REQUIRES_PERMISSION')).toEqual([
      expect.objectContaining({ from: 'command:/fly', to: 'permission:example.fly' }),
    ]);
    // plugin -> permissions
    const perms = byType('PLUGIN_DEFINES_PERMISSION');
    expect(perms.map((r) => r.to).sort()).toEqual([
      'permission:example.fly',
      'permission:example.heal',
    ]);
    // file -> source SHA
    const fileShas = byType('FILE_HAS_SHA');
    expect(fileShas).toContainEqual(
      expect.objectContaining({
        from: 'github:acme/ExamplePlugin:plugin.yml',
        to: 'sha:bbb222',
      }),
    );

    // The relationship summary itself is indexed as an artifact.
    const summary = registry.getCurrent('github:acme/ExamplePlugin:__relationships__');
    expect(summary?.status).toBe(SourceStatus.CURRENT);
  });
});

describe('GitHubIndexer — incremental indexing', () => {
  it('skips unchanged files (same blob SHA): no blob re-fetch, no re-index', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    const { indexer, registry, retrieval } = makeIndexer(client);
    const rcfg = repoCfg({ indexIssues: false });

    await indexer.indexRepo(rcfg);
    const shasAfterFirst = new Set(client.fetchedShas);
    const chunksAfterFirst = retrieval.chunks.length;
    expect(shasAfterFirst.size).toBeGreaterThan(0);

    // New indexer instance (cold commit-SHA cache) against the same tree:
    // per-file SHA comparison must skip everything.
    const { indexer: indexer2 } = makeIndexer(client, registry, retrieval);
    const report = await indexer2.indexRepo(rcfg);

    expect(report.filesUnchanged).toBe(report.filesSeen - report.filesSkipped);
    expect(report.artifactsUnchanged).toBeGreaterThan(0);
    expect(report.artifactsCreated).toBe(0);
    expect(report.artifactsSuperseded).toBe(0);
    // No NEW content fetched: every blob SHA fetched in run 2 was already
    // fetched in run 1 (the secret-suspect file is re-examined once per
    // indexer lifetime because it can never be registered — bounded and
    // documented; it still never enters the index).
    const newShas = client.fetchedShas.filter((sha) => !shasAfterFirst.has(sha));
    expect(newShas).toEqual([]);
    expect(retrieval.chunks.length).toBe(chunksAfterFirst);
  });

  it('fast-paths when the branch head commit SHA is unchanged', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    const { indexer } = makeIndexer(client);
    const rcfg = repoCfg({ indexIssues: false });

    await indexer.indexRepo(rcfg);
    const report = await indexer.indexRepo(rcfg);
    expect(report.repoUnchanged).toBe(true);
    expect(report.filesIndexed).toBe(0);
  });

  it('ACCEPTANCE: a changed commit supersedes stale chunks (old -> SUPERSEDED, new -> CURRENT)', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    const registry = new FakeRegistry();
    const retrieval = new FakeRetrieval();
    const { indexer } = makeIndexer(client, registry, retrieval);
    const rcfg = repoCfg({ indexIssues: false });

    await indexer.indexRepo(rcfg);

    const oldJava = registry.getCurrent('github:acme/ExamplePlugin:src/main/java/acme/ExamplePlugin.java');
    expect(oldJava).toBeDefined();
    const oldJavaChunks = retrieval.chunksForArtifact(oldJava!.artifactId);
    expect(oldJavaChunks.length).toBeGreaterThan(0);
    expect(oldJavaChunks.every((c) => c.status === SourceStatus.CURRENT)).toBe(true);
    const fetchesBefore = client.blobFetchCount;

    // Simulate a commit that changes ONLY the java file.
    const newJava = JAVA_SRC.replace('getLogger().info("enabled");', 'getLogger().info("v2 enabled");');
    client.editFile('commit-2', 'src/main/java/acme/ExamplePlugin.java', newJava, 'ccc999');

    const report = await indexer.indexRepo(rcfg);

    expect(report.repoUnchanged).toBe(false);
    // Changed file + manifest relationship snapshot are fetched; only the
    // changed file is re-indexed.
    expect(client.blobFetchCount).toBe(fetchesBefore + 2);
    expect(report.filesUnchanged).toBe(report.filesSeen - report.filesSkipped - 1);
    expect(report.artifactsSuperseded).toBeGreaterThanOrEqual(1);

    // Old artifact -> SUPERSEDED (history kept), new -> CURRENT.
    const staleJava = registry.all().find((a) => a.artifactId === oldJava!.artifactId);
    expect(staleJava?.status).toBe(SourceStatus.SUPERSEDED);
    expect(staleJava?.current).toBe(false);

    const newJavaArtifact = registry.getCurrent(
      'github:acme/ExamplePlugin:src/main/java/acme/ExamplePlugin.java',
    );
    expect(newJavaArtifact).toBeDefined();
    expect(newJavaArtifact!.artifactId).not.toBe(oldJava!.artifactId);
    expect(newJavaArtifact!.status).toBe(SourceStatus.CURRENT);
    expect(newJavaArtifact!.version).toBe('ccc999');
    expect(
      (newJavaArtifact!.contentMetadata?.extra as Record<string, unknown>)['commitSha'],
    ).toBe('commit-2');

    // The supersession propagated to the retrieval layer: stale chunks
    // are SUPERSEDED (excluded from current retrieval), new chunks CURRENT.
    expect(
      retrieval.statusUpdates.some(
        (u) => u.artifactId === oldJava!.artifactId && u.status === SourceStatus.SUPERSEDED,
      ),
    ).toBe(true);
    const staleChunks = retrieval.chunksForArtifact(oldJava!.artifactId);
    expect(staleChunks.length).toBeGreaterThan(0);
    expect(staleChunks.every((c) => c.status === SourceStatus.SUPERSEDED)).toBe(true);
    const freshChunks = retrieval.chunksForArtifact(newJavaArtifact!.artifactId);
    expect(freshChunks.length).toBeGreaterThan(0);
    expect(freshChunks.every((c) => c.status === SourceStatus.CURRENT)).toBe(true);
    expect(freshChunks.some((c) => c.text.includes('v2 enabled'))).toBe(true);

    // Relationship snapshot remains complete even though only Java changed.
    expect(report.relationships.some((r) => r.type === 'REPO_BUILDS_PLUGIN')).toBe(true);

    // Untouched files stayed CURRENT and were not re-indexed.
    const readme = registry.getCurrent('github:acme/ExamplePlugin:README.md');
    expect(readme?.version).toBe('aaa111');
  });

  it('supports A -> B -> A as distinct historical revisions', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    const { indexer, registry } = makeIndexer(client);
    const rcfg = repoCfg();
    await indexer.indexRepo(rcfg);
    const locator = 'github:acme/ExamplePlugin:config.yml';
    const firstA = registry.getCurrent(locator)!;
    client.editFile('commit-2', 'config.yml', 'settings:\n  debug: true\n', 'sha-b');
    await indexer.indexRepo(rcfg);
    client.editFile('commit-3', 'config.yml', CONFIG_YML, 'ddd444');
    await indexer.indexRepo(rcfg);
    const secondA = registry.getCurrent(locator)!;
    expect(secondA.version).toBe('ddd444');
    expect(secondA.artifactId).not.toBe(firstA.artifactId);
    expect(registry.all().filter((a) => a.sourceLocator === locator)).toHaveLength(3);
  });

  it('stales an old value when changed content becomes secret-suspect', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    const { indexer, registry, retrieval } = makeIndexer(client);
    const rcfg = repoCfg();
    await indexer.indexRepo(rcfg);
    const locator = 'github:acme/ExamplePlugin:config.yml';
    const old = registry.getCurrent(locator)!;
    client.editFile(
      'commit-2',
      'config.yml',
      ['api_key: ', 'ghp_', 'abcdefghijklmnopqrstuvwx'].join(''),
      'secret-2',
    );
    await indexer.indexRepo(rcfg);
    expect(registry.getCurrent(locator)?.status).toBe(SourceStatus.STALE);
    expect(retrieval.chunksForArtifact(old.artifactId).every((c) => c.status === SourceStatus.STALE)).toBe(true);
  });

  it('retries transient blob failures instead of caching a partial commit', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    const { indexer, registry } = makeIndexer(client);
    const rcfg = repoCfg();
    await indexer.indexRepo(rcfg);
    client.editFile('commit-2', 'config.yml', 'settings:\n  debug: true\n', 'retry-sha');
    client.failBlobShas.add('retry-sha');
    const failed = await indexer.indexRepo(rcfg);
    expect(failed.errors.length).toBeGreaterThan(0);
    expect(registry.getCurrent('github:acme/ExamplePlugin:config.yml')?.status).toBe(SourceStatus.STALE);
    const retried = await indexer.indexRepo(rcfg);
    expect(retried.repoUnchanged).toBe(false);
    expect(retried.errors).toEqual([]);
    expect(registry.getCurrent('github:acme/ExamplePlugin:config.yml')?.status).toBe(SourceStatus.CURRENT);
  });

  it('stales the relationship summary instead of publishing a partial snapshot', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    const { indexer, registry, retrieval } = makeIndexer(client);
    const rcfg = repoCfg({ indexIssues: false });
    await indexer.indexRepo(rcfg);
    const locator = 'github:acme/ExamplePlugin:__relationships__';
    const original = registry.getCurrent(locator)!;

    client.editFile(
      'commit-2',
      'src/main/java/acme/ExamplePlugin.java',
      JAVA_SRC.replace('enabled', 'v2 enabled'),
      'java-v2',
    );
    client.failBlobShas.add('bbb222');
    const failed = await indexer.indexRepo(rcfg);

    expect(failed.errors.some((e) => e.includes('relationships plugin.yml'))).toBe(true);
    expect(registry.getCurrent(locator)?.artifactId).toBe(original.artifactId);
    expect(registry.getCurrent(locator)?.status).toBe(SourceStatus.STALE);
    expect(retrieval.chunksForArtifact(original.artifactId).every((c) => c.status === SourceStatus.STALE)).toBe(true);

    const retry = await indexer.indexRepo(rcfg);
    expect(retry.errors).toEqual([]);
    expect(registry.getCurrent(locator)?.status).toBe(SourceStatus.CURRENT);
  });

  it('marks deleted files INVALID and flips their chunks', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    const registry = new FakeRegistry();
    const retrieval = new FakeRetrieval();
    const { indexer } = makeIndexer(client, registry, retrieval);
    const rcfg = repoCfg({ indexIssues: false });

    await indexer.indexRepo(rcfg);
    const configArtifact = registry.getCurrent('github:acme/ExamplePlugin:config.yml');
    expect(configArtifact?.status).toBe(SourceStatus.CURRENT);

    client.deleteFile('commit-3', 'config.yml');
    const report = await indexer.indexRepo(rcfg);

    expect(report.filesInvalidated).toBe(1);
    const invalid = registry.all().find((a) => a.artifactId === configArtifact!.artifactId);
    expect(invalid?.status).toBe(SourceStatus.INVALID);
    expect(
      retrieval.statusUpdates.some(
        (u) => u.artifactId === configArtifact!.artifactId && u.status === SourceStatus.INVALID,
      ),
    ).toBe(true);
  });
});

describe('GitHubIndexer — issues and PR metadata', () => {
  it('indexes issue metadata when enabled, and supersedes on update', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    client.issues = [
      {
        number: 7,
        title: 'Flight breaks in the nether',
        body: 'Steps to reproduce...',
        state: 'open',
        author: 'tester',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-02T00:00:00Z',
        labels: ['bug'],
      },
    ];
    const registry = new FakeRegistry();
    const retrieval = new FakeRetrieval();
    const { indexer } = makeIndexer(client, registry, retrieval);
    const rcfg = repoCfg({ indexIssues: true });

    const report = await indexer.indexRepo(rcfg);
    expect(report.issuesIndexed).toBe(1);
    const issue = registry.getCurrent('github:acme/ExamplePlugin:issues/7');
    expect(issue?.status).toBe(SourceStatus.CURRENT);
    expect(issue?.visibility).toBe(Visibility.STAFF);
    const issueChunks = retrieval.chunksForArtifact(issue!.artifactId);
    expect(issueChunks.some((c) => c.text.includes('Flight breaks in the nether'))).toBe(true);

    // Issue body edited -> new version supersedes the old artifact.
    client.issues = [
      {
        number: 7,
        title: 'Flight breaks in the nether',
        body: 'Steps to reproduce... (updated with logs)',
        state: 'open',
        author: 'tester',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-05T00:00:00Z',
        labels: ['bug'],
      },
    ];
    const report2 = await indexer.indexRepo(rcfg);
    expect(report2.artifactsSuperseded).toBeGreaterThanOrEqual(1);
    const stale = registry.all().find((a) => a.artifactId === issue!.artifactId);
    expect(stale?.status).toBe(SourceStatus.SUPERSEDED);
  });

  it('stales issue metadata on list failure and revalidates it after recovery', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    client.issues = [{
      number: 7,
      title: 'Transient metadata',
      body: 'body',
      state: 'open',
      author: 'tester',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-02T00:00:00Z',
      labels: [],
    }];
    const { indexer, registry, retrieval } = makeIndexer(client);
    const rcfg = repoCfg({ indexIssues: true });
    await indexer.indexRepo(rcfg);
    const locator = 'github:acme/ExamplePlugin:issues/7';
    const issue = registry.getCurrent(locator)!;

    client.failIssueList = true;
    const failed = await indexer.indexRepo(rcfg);
    expect(failed.errors.some((e) => e.includes('issues: transient issue-list failure'))).toBe(true);
    expect(registry.getCurrent(locator)?.status).toBe(SourceStatus.STALE);
    expect(retrieval.chunksForArtifact(issue.artifactId).every((c) => c.status === SourceStatus.STALE)).toBe(true);

    client.failIssueList = false;
    const recovered = await indexer.indexRepo(rcfg);
    expect(recovered.errors).toEqual([]);
    expect(registry.getCurrent(locator)?.status).toBe(SourceStatus.CURRENT);
    expect(retrieval.chunksForArtifact(issue.artifactId).every((c) => c.status === SourceStatus.CURRENT)).toBe(true);
  });

  it('does not index issues when disabled', async () => {
    const client = new MockGitHubApi('commit-1', fixtureFiles());
    client.issues = [
      {
        number: 7,
        title: 'x',
        body: 'y',
        state: 'open',
        author: 'tester',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-02T00:00:00Z',
        labels: [],
      },
    ];
    const { indexer, registry } = makeIndexer(client);
    await indexer.indexRepo({
      owner: 'acme',
      repo: 'ExamplePlugin',
      codeVisibility: Visibility.STAFF,
      docsVisibility: Visibility.STAFF,
      indexIssues: false,
      indexPullRequests: false,
      includePaths: [],
      excludePaths: [],
    });
    expect(registry.getCurrent('github:acme/ExamplePlugin:issues/7')).toBeUndefined();
  });
});

describe('config', () => {
  it('requires a token and defaults visibility conservatively', () => {
    delete process.env.GITHUB_TOKEN;
    expect(() => loadGitHubIndexerConfig({ repos: [] })).toThrow(/no API token/);

    const cfg = loadGitHubIndexerConfig({
      token: 'abc',
      repos: [{ owner: 'acme', repo: 'ExamplePlugin' }],
    });
    expect(cfg.token).toBe('abc');
    expect(cfg.repos[0]?.codeVisibility).toBe(Visibility.STAFF);
    expect(cfg.repos[0]?.docsVisibility).toBe(Visibility.STAFF);
    expect(cfg.repos[0]?.discussionVisibility).toBe(Visibility.STAFF);
    expect(cfg.repos[0]?.indexIssues).toBe(false);
    expect(cfg.maxFileBytes).toBe(1024 * 1024);
  });

  it('reads the token from the environment', () => {
    process.env.GITHUB_TOKEN = 'env-token';
    try {
      const cfg = loadGitHubIndexerConfig({ repos: [] });
      expect(cfg.token).toBe('env-token');
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('rejects invalid repo entries', () => {
    expect(() =>
      loadGitHubIndexerConfig({ token: 'abc', repos: [{ owner: '', repo: 'x' }] }),
    ).toThrow();
  });
});

describe('RestGitHubClient — secret safety', () => {
  const secretToken = 'ghp_testtoken_that_must_never_leak_12345';

  it('never includes the token in HTTP error messages', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const client = new RestGitHubClient({
      token: secretToken,
      userAgent: 'test',
      fetchImpl,
    });
    const error = await client.getRepoMeta('acme', 'ExamplePlugin').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as Error).message).not.toContain(secretToken);
  });

  it('scrubs the token even if an API error body echoes it', async () => {
    const fetchImpl = (async () =>
      new Response(`bad credential ${secretToken}`, { status: 401 })) as typeof fetch;
    const client = new RestGitHubClient({
      token: secretToken,
      userAgent: 'test',
      fetchImpl,
    });
    const error = await client.getRepoMeta('acme', 'ExamplePlugin').catch((e) => e);
    expect((error as Error).message).not.toContain(secretToken);
  });

  it('never includes the token in network-failure messages', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hangup');
    }) as typeof fetch;
    const client = new RestGitHubClient({
      token: secretToken,
      userAgent: 'test',
      fetchImpl,
    });
    const error = await client.getRepoMeta('acme', 'ExamplePlugin').catch((e) => e);
    expect((error as Error).message).not.toContain(secretToken);
  });
});

describe('parsers', () => {
  it('classifies paths', () => {
    expect(classifyPath('README.md')).toBe('doc');
    expect(classifyPath('docs/guide.md')).toBe('doc');
    expect(classifyPath('plugin.yml')).toBe('manifest');
    expect(classifyPath('src/main/resources/paper-plugin.yml')).toBe('manifest');
    expect(classifyPath('src/main/java/acme/Foo.java')).toBe('code');
    expect(classifyPath('src/index.ts')).toBe('code');
    expect(classifyPath('bot.py')).toBe('code');
    expect(classifyPath('config.yml')).toBe('config');
    expect(classifyPath('assets/logo.png')).toBe('skip');
    expect(classifyPath('node_modules/foo/index.js')).toBe('skip');
    expect(classifyPath('.env')).toBe('skip');
    expect(classifyPath('package-lock.json')).toBe('skip');
    expect(classifyPath('target/classes/Foo.class')).toBe('skip');
  });

  it('parses a bukkit plugin.yml into commands and permissions', () => {
    const manifest = parseManifest('bukkit', PLUGIN_YML);
    expect(manifest.name).toBe('ExamplePlugin');
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.main).toBe('acme.ExamplePlugin');
    expect(manifest.commands.map((c) => c.name).sort()).toEqual(['fly', 'heal']);
    const fly = manifest.commands.find((c) => c.name === 'fly');
    expect(fly?.permission).toBe('example.fly');
    expect(fly?.description).toBe('Toggle flight');
    expect(manifest.permissions.map((p) => p.node).sort()).toEqual([
      'example.fly',
      'example.heal',
    ]);
    const flyPerm = manifest.permissions.find((p) => p.node === 'example.fly');
    expect(flyPerm?.default).toBe('op');
  });

  it('extracts java symbols with regexes', () => {
    const symbols = extractSymbols('java', JAVA_SRC);
    const names = symbols.map((s) => s.name);
    expect(names).toContain('ExamplePlugin');
    expect(names).toContain('onEnable');
    expect(names).toContain('onCommand');
  });

  it('flags secret-looking content', () => {
    expect(looksLikeSecret('key: ghp_abcdefghijklmnopqrstuvwx')).toBe(true);
    expect(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----\n...')).toBe(true);
    expect(looksLikeSecret('password = "supersecretvalue123"')).toBe(true);
    expect(looksLikeSecret('public void onEnable() { }')).toBe(false);
  });

  it('parses the YAML subset used by manifests', () => {
    const doc = parseSimpleYaml('name: Foo\nversion: 1.0\n');
    expect(doc['name']).toBe('Foo');
  });
});
