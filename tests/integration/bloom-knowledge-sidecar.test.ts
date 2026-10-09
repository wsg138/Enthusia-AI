import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockGitHubApi } from '../../integrations/github/test/fakes.js';
import {
  APPROVED_REPOS, createKnowledgeStaging, knowledgeConfig,
} from '../../deploy/bloom/knowledge-staging.mjs';

const KEY = 'synthetic-indexer-key-not-real-987654321';
const pie = new MockGitHubApi('a'.repeat(40), [
  { path: 'README.md', sha: 'b'.repeat(40), content: '# PieCloak\nPieCloak hides entity clues from pie chart base detection.' },
  { path: 'src/StaffInternal.java', sha: 'c'.repeat(40), content: 'private-staff-internal-algorithm' },
  { path: '.env', sha: 'd'.repeat(40), content: 'TOKEN=not-a-real-secret' },
]);
const war = new MockGitHubApi('e'.repeat(40), [
  { path: 'README.md', sha: 'f'.repeat(40), content: '# MaceGuard\nWarzones rotate PvP combat kits and modifiers on an anchored schedule.' },
]);
const clients = { PieCloak: pie, MaceGuard: war };
function client() {
  const repo = (name: string) => {
    if (name === 'PieCloak' || name === 'MaceGuard') return clients[name];
    throw new Error('A non-approved repo was accessed');
  };
  return {
    getRepoMeta: (owner: string, name: string) => repo(name).getRepoMeta(owner, name),
    getBranchHeadSha: (_owner: string, name: string, _branch: string) =>
      (void _branch, repo(name).getBranchHeadSha()),
    getRecursiveTree: (_owner: string, name: string, _sha: string) =>
      (void _sha, repo(name).getRecursiveTree()),
    getBlob: (owner: string, name: string, sha: string) =>
      repo(name).getBlob(owner, name, sha),
    listIssues: (_owner: string, name: string) => repo(name).listIssues(),
    listPullRequests: (_owner: string, name: string) => repo(name).listPullRequests(),
  };
}
const folders: string[] = [];
const services: Array<{ close(): Promise<void> }> = [];
async function opened() {
  const dir = await mkdtemp(join(tmpdir(), 'enthusia-knowledge-sidecar-'));
  folders.push(dir);
  const service = await createKnowledgeStaging({ dir, apiKey: KEY, client: client() });
  services.push(service);
  return { service, dir };
}
async function request(port: number, question: unknown, token = KEY, extra = {}) {
  const res = await fetch('http://127.0.0.1:' + port + '/v1/search', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ question, ...extra }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true });
  pie.setCommit('a'.repeat(40), [
    { path: 'README.md', sha: 'b'.repeat(40), content: '# PieCloak\nPieCloak hides entity clues from pie chart base detection.' },
    { path: 'src/StaffInternal.java', sha: 'c'.repeat(40), content: 'private-staff-internal-algorithm' },
    { path: '.env', sha: 'd'.repeat(40), content: 'TOKEN=not-a-real-secret' },
  ]);
});

describe('durable W08/W04/W07 Bloom sidecar (synthetic GitHub, real SQLite)', () => {
  it('rejects arbitrary repos, production mode, missing secrets and relative storage', () => {
    const base = {
      NODE_ENV: 'development',
      ENTHUSIA_BLOOM_STAGING: '1',
      ENTHUSIA_INDEXER_GITHUB_TOKEN: 'synthetic-github-token',
      ENTHUSIA_INDEXER_API_KEY: KEY,
      ENTHUSIA_INDEXER_DATA_DIR: join(tmpdir(), 'knowledge-test'),
      ENTHUSIA_INDEXER_APPROVED_REPOS: APPROVED_REPOS.join(','),
    };
    expect(knowledgeConfig(base).port).toBe(4300);
    expect(() => knowledgeConfig({ ...base, NODE_ENV: 'production' })).toThrow('isolated development');
    expect(() => knowledgeConfig({ ...base, ENTHUSIA_INDEXER_APPROVED_REPOS: 'owner/private' })).toThrow('allowlist');
    expect(() => knowledgeConfig({ ...base, ENTHUSIA_INDEXER_DATA_DIR: './relative' })).toThrow('absolute');
    expect(() => knowledgeConfig({ ...base, ENTHUSIA_INDEXER_API_KEY: '' })).toThrow('service key');
  });

  it('indexes both approved repos using persistent W04/W07 and returns only CURRENT PUBLIC chunks', async () => {
    const { service } = await opened();
    const port = await service.listen(0);
    const before = await request(port, 'Warzones combat rotation');
    expect(before.status).toBe(503);
    expect(await service.refresh()).toBe(true);
    expect(service.fresh()).toBe(true);
    expect(service.retrieval.indexedCount()).toBeGreaterThan(0);
    expect(service.registry.getCurrent('github:wsg138/PieCloak:src/StaffInternal.java')).toBeUndefined();
    expect(service.registry.getCurrent('github:wsg138/PieCloak:.env')).toBeUndefined();
    const result = await request(port, 'Warzones combat kits schedule');
    expect(result.status).toBe(200);
    expect(result.body.sourceMode).toBe('github-documentation-only');
    expect(result.body.deploymentVerified).toBe(false);
    const hits = result.body.hits as Array<{ text: string; status: string; sourceLocator: string; deploymentVerified: boolean }>;
    expect(hits.some(h => h.sourceLocator === 'github:wsg138/MaceGuard:README.md')).toBe(true);
    expect(hits.every(h => h.status === 'CURRENT' && h.deploymentVerified === false)).toBe(true);
    expect(hits.some(h => h.sourceLocator === 'github:wsg138/MaceGuard:README.md' &&
      (h as typeof h & { commitSha: string }).commitSha === 'e'.repeat(40))).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain('private-staff-internal-algorithm');
    expect(JSON.stringify(result.body)).not.toContain('not-a-real-secret');
  });

  it('requires authorization and rejects caller-selected visibility or history', async () => {
    const { service } = await opened();
    const port = await service.listen(0);
    await service.refresh();
    expect((await request(port, 'PieCloak', 'bad')).status).toBe(401);
    expect((await request(port, 'PieCloak', KEY, { visibilityCeiling: 'STAFF' })).status).toBe(400);
    expect((await request(port, 'PieCloak', KEY, { includeHistorical: true })).status).toBe(400);
    expect((await request(port, 'q')).status).toBe(400);
  });

  it('persists artifacts and chunks across process recreation, but refuses stale queries', async () => {
    const { service, dir } = await opened();
    expect(await service.refresh()).toBe(true);
    const current = service.registry.getCurrent('github:wsg138/PieCloak:README.md');
    expect(current?.version).toBe('b'.repeat(40));
    await service.close();
    services.pop();
    const next = await createKnowledgeStaging({ dir, apiKey: KEY, client: client() });
    services.push(next);
    expect(next.registry.getCurrent('github:wsg138/PieCloak:README.md')?.version).toBe(current?.version);
    expect(next.retrieval.indexedCount()).toBeGreaterThan(0);
    expect(next.fresh()).toBe(false);
    expect(await next.search('PieCloak hide entity clues')).toBeNull();
    expect(await next.refresh()).toBe(true);
    expect((await next.search('PieCloak hide entity clues'))?.length).toBeGreaterThan(0);
  });

  it('excludes superseded documents from regular search', async () => {
    const { service } = await opened();
    expect(await service.refresh()).toBe(true);
    const prior = service.registry.getCurrent('github:wsg138/PieCloak:README.md');
    pie.editFile('1'.repeat(40), 'README.md',
      '# PieCloak\nNew replacement document: hides different clues.', '2'.repeat(40));
    expect(await service.refresh()).toBe(true);
    expect(service.registry.getCurrent('github:wsg138/PieCloak:README.md')?.version).toBe('2'.repeat(40));
    const hits = await service.search('PieCloak replacement document hides clues');
    expect(hits?.some(h => h.version === prior?.version)).toBe(false);
    expect(hits?.every(h => h.status === 'CURRENT')).toBe(true);
  });

  it('fails closed after a refresh error rather than trusting last persisted data', async () => {
    const { service } = await opened();
    expect(await service.refresh()).toBe(true);
    // An index attempt with a source error must make existing answers unavailable.
    pie.failBlobShas.add('3'.repeat(40));
    pie.editFile('4'.repeat(40), 'README.md', 'New text requiring failed blob', '3'.repeat(40));
    expect(await service.refresh()).toBe(false);
    expect(service.fresh()).toBe(false);
    expect(await service.search('PieCloak hide clues')).toBeNull();
    pie.failBlobShas.clear();
  });
});
