/**
 * Test-only proof that REAL W08 indexer -> W04 registry -> W07 retrieval
 * can be composed with strict PUBLIC ceiling and CURRENT-only default.
 *
 * All documents, SHAs and API responses in this test are synthetic.
 * No credentials, remote API, production state or Discord messages.
 */
import { describe, expect, it } from 'vitest';
import { SourceStatus, Visibility } from '@enthusia/contracts';
import { SourceProvenanceStore, SourceRegistry } from '@enthusia/source-provenance';
import {
  FixedWindowChunker,
  HashingEmbeddingProvider,
  InMemoryLexicalIndex,
  InMemoryVectorStore,
  KnowledgeRetrievalEngine,
  SqliteChunkStore,
} from '@enthusia/knowledge-indexer/retrieval';
import { GitHubIndexer } from '../src/indexer.js';
import { MockGitHubApi } from './fakes.js';

function testStack() {
  const registryStore = new SourceProvenanceStore({ path: ':memory:' });
  const registry = new SourceRegistry(registryStore);
  const dimension = 128;
  const retrieval = new KnowledgeRetrievalEngine({
    chunkStore: new SqliteChunkStore(':memory:'),
    vectorStore: new InMemoryVectorStore(dimension),
    lexicalIndex: new InMemoryLexicalIndex(),
    embeddingProvider: new HashingEmbeddingProvider({ dimension }),
    defaultChunker: new FixedWindowChunker({ maxChars: 1200, overlapChars: 0 }),
  });
  return { registryStore, registry, retrieval };
}

function approvedIndex(
  repo: string,
  client: MockGitHubApi,
  registry: SourceRegistry,
  retrieval: KnowledgeRetrievalEngine,
) {
  return new GitHubIndexer({
    token: 'synthetic-fixture-placeholder-not-a-real-secret',
    repos: [{
      owner: 'wsg138', repo, branch: 'main',
      codeVisibility: Visibility.STAFF,
      docsVisibility: Visibility.PUBLIC,
      indexIssues: false, indexPullRequests: false,
      excludePaths: [],
    }],
  }, { client, registry, retrieval });
}

describe('W08 + W04 + W07 actual composition, no live network', () => {
  it('indexes multiple approved public READMEs while never exposing staff code', async () => {
    const { registryStore, registry, retrieval } = testStack();
    try {
      const pie = new MockGitHubApi('a'.repeat(40), [
        { path: 'README.md', sha: 'b'.repeat(40), content: '# PieCloak\nPieCloak hides entity clues to prevent base finding.' },
        { path: 'src/Internal.java', sha: 'c'.repeat(40), content: 'class Internal { String staffOnlyCode = "private-algorithm"; }' },
        { path: '.env', sha: 'd'.repeat(40), content: 'SECRET=synthetic-not-real' },
      ]);
      const war = new MockGitHubApi('e'.repeat(40), [
        { path: 'README.md', sha: 'f'.repeat(40), content: '# MaceGuard\nWarzones rotate modifiers and kits on a schedule.' },
      ]);
      const idxPie = approvedIndex('PieCloak', pie, registry, retrieval);
      const idxWar = approvedIndex('MaceGuard', war, registry, retrieval);
      const p = await idxPie.indexAll();
      const w = await idxWar.indexAll();
      expect(p[0]?.errors).toEqual([]);
      expect(w[0]?.errors).toEqual([]);
      const pieDoc = registry.getCurrent('github:wsg138/PieCloak:README.md');
      const warDoc = registry.getCurrent('github:wsg138/MaceGuard:README.md');
      expect(pieDoc?.visibility).toBe(Visibility.PUBLIC);
      expect(warDoc?.visibility).toBe(Visibility.PUBLIC);
      expect(registry.getCurrent('github:wsg138/PieCloak:src/Internal.java')?.visibility).toBe(Visibility.STAFF);
      expect(registry.getCurrent('github:wsg138/PieCloak:.env')).toBeUndefined();

      const hits = await retrieval.search('Warzones rotation modifiers schedule', { visibilityCeiling: Visibility.PUBLIC });
      expect(hits.results.some((h) => h.chunk.sourceLocator === 'github:wsg138/MaceGuard:README.md')).toBe(true);
      expect(hits.results.every((h) => h.chunk.visibility === Visibility.PUBLIC)).toBe(true);
      expect(hits.results.every((h) => h.provenance.status === SourceStatus.CURRENT)).toBe(true);
      expect(hits.results.some((h) => h.chunk.sourceLocator.endsWith('Internal.java'))).toBe(false);

      const denied = await retrieval.search('private-algorithm', { visibilityCeiling: Visibility.PUBLIC });
      expect(denied.results.every((h) => !h.chunk.text.includes('private-algorithm'))).toBe(true);
    } finally {
      retrieval.close();
      registryStore.close();
    }
  });

  it('removes superseded documentation from CURRENT search without deleting history', async () => {
    const { registryStore, registry, retrieval } = testStack();
    try {
      const mock = new MockGitHubApi('1'.repeat(40), [
        { path: 'README.md', sha: '2'.repeat(40), content: '# PieCloak\nOld base protection visibility policy.' },
      ]);
      const indexer = approvedIndex('PieCloak', mock, registry, retrieval);
      await indexer.indexAll();
      const old = registry.getCurrent('github:wsg138/PieCloak:README.md');
      expect(old?.status).toBe(SourceStatus.CURRENT);
      mock.editFile('3'.repeat(40), 'README.md', '# PieCloak\nNew base protection visibility policy.', '4'.repeat(40));
      await indexer.indexAll();
      expect(registry.getCurrent('github:wsg138/PieCloak:README.md')?.version).toBe('4'.repeat(40));
      const current = await retrieval.search('base protection policy', { visibilityCeiling: Visibility.PUBLIC });
      expect(current.results.some((h) => h.provenance.artifactId === old?.artifactId)).toBe(false);
      const history = await retrieval.search('base protection policy', {
        visibilityCeiling: Visibility.PUBLIC, includeHistorical: true,
      });
      expect(history.results.some((h) =>
        h.provenance.artifactId === old?.artifactId &&
        h.provenance.status === SourceStatus.SUPERSEDED &&
        h.historical)).toBe(true);
    } finally {
      retrieval.close();
      registryStore.close();
    }
  });

  it('does not equate a current GitHub document with verified production deployment', async () => {
    const { registryStore, registry, retrieval } = testStack();
    try {
      const docCommit = '5'.repeat(40);
      const mock = new MockGitHubApi(docCommit, [
        { path: 'README.md', sha: '6'.repeat(40), content: '# MaceGuard\nWarzones combat kits rotate.' },
      ]);
      await approvedIndex('MaceGuard', mock, registry, retrieval).indexAll();
      const unknownDeployment = await retrieval.search('Warzones combat kits rotate', {
        visibilityCeiling: Visibility.PUBLIC,
        production: { deployedGitShas: {} },
      });
      expect(unknownDeployment.results).toHaveLength(0);
      const wrongDeployment = await retrieval.search('Warzones combat kits rotate', {
        visibilityCeiling: Visibility.PUBLIC,
        production: { deployedGitShas: { 'github:wsg138/MaceGuard': '7'.repeat(40) } },
      });
      expect(wrongDeployment.results).toHaveLength(0);
      const matched = await retrieval.search('Warzones combat kits rotate', {
        visibilityCeiling: Visibility.PUBLIC,
        production: { deployedGitShas: { 'github:wsg138/MaceGuard': docCommit } },
      });
      expect(matched.results.some((h) => h.chunk.sourceLocator === 'github:wsg138/MaceGuard:README.md')).toBe(true);
    } finally {
      retrieval.close();
      registryStore.close();
    }
  });
});
