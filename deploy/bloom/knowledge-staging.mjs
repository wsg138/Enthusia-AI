/**
 * Isolated one-container knowledge sidecar: REAL W08 -> W04 -> W07.
 *
 * Not automatically enabled, deployed or connected to the Agent.
 * Only the operator-approved public PieCloak and MaceGuard repositories
 * are permitted. GitHub source is NOT evidence of current SMP deployment.
 */
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Visibility } from '@enthusia/contracts';
import { SourceProvenanceStore, SourceRegistry } from '@enthusia/source-provenance';
import {
  FixedWindowChunker, HashingEmbeddingProvider,
  InMemoryVectorStore, InMemoryLexicalIndex,
  SqliteChunkStore, KnowledgeRetrievalEngine,
} from '@enthusia/knowledge-indexer/retrieval';
import { GitHubIndexer, RestGitHubClient } from '@enthusia/integration-github';

export const APPROVED_REPOS = Object.freeze(['wsg138/MaceGuard', 'wsg138/PieCloak']);
const INDEX_REFRESH_MS = 15 * 60_000;
const FRESH_MAX_MS = 30 * 60_000;
const MAX_REQUEST_BYTES = 2048;
const DIMENSION = 128; // Test-only deterministic embedding; NOT production semantic quality.
const PUBLIC_DOCS = APPROVED_REPOS.map((full) => ({
  owner: 'wsg138', repo: full.split('/')[1], branch: 'main',
  codeVisibility: Visibility.STAFF, docsVisibility: Visibility.PUBLIC,
  indexIssues: false, indexPullRequests: false, excludePaths: [],
  maxFileBytes: 128 * 1024,
}));

function exactAllowlist(value) {
  if (value !== APPROVED_REPOS.join(',')) {
    throw new Error('Indexer repositories do not match the approved public allowlist');
  }
}
function checkedKey(value) {
  if (typeof value !== 'string' || value.length < 24 || value.length > 200) {
    throw new Error('Private indexer service key is missing or invalid');
  }
  return value;
}
export function knowledgeConfig(env = process.env) {
  if (env.NODE_ENV !== 'development' || env.ENTHUSIA_BLOOM_STAGING !== '1') {
    throw new Error('Knowledge sidecar requires isolated development staging');
  }
  exactAllowlist(env.ENTHUSIA_INDEXER_APPROVED_REPOS);
  const folder = env.ENTHUSIA_INDEXER_DATA_DIR;
  if (typeof folder !== 'string' || !isAbsolute(folder)) {
    throw new Error('Persistent knowledge directory must be absolute');
  }
  const port = Number(env.ENTHUSIA_INDEXER_PORT ?? '4300');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Invalid knowledge sidecar port');
  }
  const token = env.ENTHUSIA_INDEXER_GITHUB_TOKEN;
  if (typeof token !== 'string' || token.length < 8) {
    throw new Error('Dedicated knowledge source token is required');
  }
  const apiKey = checkedKey(env.ENTHUSIA_INDEXER_API_KEY);
  return { dir: resolve(folder), port, token, apiKey };
}
function authorized(header, key) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(key, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export async function createKnowledgeStaging(options) {
  const dir = options.dir;
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('Knowledge storage must be absolute');
  checkedKey(options.apiKey);
  if (!options.client || typeof options.client.getRepoMeta !== 'function') {
    throw new Error('No validated source client configured');
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const registryStore = new SourceProvenanceStore({ path: join(dir, 'sources.sqlite') });
  const chunkStore = new SqliteChunkStore(join(dir, 'chunks.sqlite'));
  const retrieval = new KnowledgeRetrievalEngine({
    chunkStore, vectorStore: new InMemoryVectorStore(DIMENSION),
    lexicalIndex: new InMemoryLexicalIndex(),
    embeddingProvider: new HashingEmbeddingProvider({ dimension: DIMENSION }),
    defaultChunker: new FixedWindowChunker({ maxChars: 1000, overlapChars: 80 }),
  });
  const registry = new SourceRegistry(registryStore);
  let lastVerifiedAt = 0;
  let refreshing = false;
  let closed = false;
  let timer;
  let server;
  try {
    await retrieval.rebuildIndexes();
    const indexer = new GitHubIndexer({
      token: 'managed-out-of-process', repos: PUBLIC_DOCS,
      maxFileBytes: 128 * 1024,
    }, { client: options.client, registry, retrieval });
    const refresh = async () => {
      if (refreshing || closed) return false;
      refreshing = true;
      // Source truth must be confirmed in THIS process, after EACH refresh.
      lastVerifiedAt = 0;
      try {
        const reports = await indexer.indexAll();
        if (reports.length !== 2 || reports.some((r) => r.errors.length > 0)) return false;
        lastVerifiedAt = Date.now();
        return true;
      } catch {
        return false; // Ignore untrusted API error bodies; no stale answers.
      } finally {
        refreshing = false;
      }
    };
    const fresh = () => !closed && !refreshing && lastVerifiedAt !== 0 &&
      Date.now() - lastVerifiedAt <= FRESH_MAX_MS;

    const search = async (question) => {
      if (!fresh()) return null;
      if (typeof question !== 'string' || question.length < 3 || question.length > 160 ||
          /[\u0000-\u001f]/.test(question)) return null;
      const results = await retrieval.search(question, {
        visibilityCeiling: Visibility.PUBLIC,
        includeHistorical: false,
        limit: 5,
      });
      return results.results.filter((h) => h.chunk.visibility === Visibility.PUBLIC &&
          APPROVED_REPOS.some((repo) => h.chunk.sourceLocator.startsWith('github:' + repo + ':')) &&
          h.provenance.status === 'CURRENT')
        .map((h) => ({
          text: h.chunk.text.slice(0, 1100),
          sourceLocator: h.provenance.sourceLocator,
          version: h.provenance.version,
          artifactId: h.provenance.artifactId,
          status: h.provenance.status,
          score: h.score,
          // Explicitly source/docs only, never pretend this is live deployment.
          deploymentVerified: false,
        }));
    };

    const handle = async (req, res) => {
      const reply = (status, body) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(JSON.stringify(body));
      };
      if (!authorized(req.headers.authorization, options.apiKey)) {
        reply(401, { error: 'unauthorized' });
        return;
      }
      if (req.url === '/health/ready' && req.method === 'GET') {
        reply(fresh() ? 200 : 503, { status: fresh() ? 'ok' : 'unavailable' });
        return;
      }
      if (req.url !== '/v1/search' || req.method !== 'POST') {
        reply(404, { error: 'not_found' });
        return;
      }
      if (!fresh()) {
        reply(503, { error: 'unverified_sources' });
        return;
      }
      try {
        let body = '';
        for await (const part of req) {
          body += String(part);
          if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
            reply(413, { error: 'request_too_large' });
            return;
          }
        }
        const parsed = JSON.parse(body);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
            Object.keys(parsed).length !== 1 || typeof parsed.question !== 'string') {
          reply(400, { error: 'invalid_question' }); return;
        }
        const hits = await search(parsed.question);
        if (!hits) { reply(400, { error: 'invalid_question' }); return; }
        reply(200, { hits, sourceMode: 'github-documentation-only', deploymentVerified: false });
      } catch {
        reply(400, { error: 'invalid_request' });
      }
    };
    const listen = async (port) => {
      if (server) throw new Error('Knowledge sidecar already listening');
      server = createServer((req, res) => { void handle(req, res); });
      await new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(port, '127.0.0.1', done);
      });
      return server.address().port;
    };
    const start = async (port) => {
      await listen(port);
      await refresh();
      timer = setInterval(() => { void refresh(); }, INDEX_REFRESH_MS);
      timer.unref();
    };
    const close = async () => {
      closed = true;
      if (timer) clearInterval(timer);
      if (server) await new Promise((done) => server.close(done));
      retrieval.close();
      registryStore.close();
    };
    return { start, listen, refresh, search, close, registry, retrieval, fresh };
  } catch (error) {
    retrieval.close();
    registryStore.close();
    throw error;
  }
}

async function main() {
  const cfg = knowledgeConfig();
  const client = new RestGitHubClient({
    token: cfg.token, userAgent: 'enthusia-bloom-isolated-knowledge/1.0',
    requestTimeoutMs: 6000,
  });
  const service = await createKnowledgeStaging({
    dir: cfg.dir, apiKey: cfg.apiKey, client,
  });
  try {
    await service.start(cfg.port);
    console.log('[knowledge-staging] Loopback sidecar listening. Sources: approved public documentation only.');
    // No source error details or credentials in logs.
    console.log('[knowledge-staging] Public source status: ' +
      (service.fresh() ? 'verified' : 'unavailable'));
    const shutdown = () => { void service.close().then(() => process.exit(0), () => process.exit(1)); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch {
    await service.close();
    throw new Error('Knowledge sidecar could not start');
  }
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/')).href) {
  main().catch(() => {
    console.error('[knowledge-staging] Start failed (no credentials or source text logged).');
    process.exitCode = 1;
  });
}
