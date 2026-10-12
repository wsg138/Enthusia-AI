import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { untilKnowledgeReady } from '../../deploy/bloom/single-server-staging.mjs';

const key = 'synthetic-indexer-key-not-real';
const servers: Server[] = [];
async function fakeIndexer(status = 200) {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer ' + key) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: status === 200 ? 'ok' : 'unavailable' }));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral indexer port');
  return address.port;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
const alive = { exitCode: null, signalCode: null };

describe('opt-in knowledge indexer readiness', () => {
  it('requires an authenticated fresh source response', async () => {
    const port = await fakeIndexer();
    await expect(untilKnowledgeReady(port, key, alive, 900)).resolves.toBeUndefined();
  });
  it('does not accept a missing or wrong internal key', async () => {
    const port = await fakeIndexer();
    await expect(untilKnowledgeReady(port, 'wrong', alive, 80))
      .rejects.toThrow('did not verify approved sources');
  });
  it('does not accept HTTP 503 indicating missing or stale sources', async () => {
    const port = await fakeIndexer(503);
    await expect(untilKnowledgeReady(port, key, alive, 80))
      .rejects.toThrow('did not verify approved sources');
  });
  it('fails immediately on an unexpected child exit', async () => {
    await expect(untilKnowledgeReady(15555, key, {
      exitCode: 1, signalCode: null,
    }, 900)).rejects.toThrow('exited before readiness');
  });
});
