import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { untilInferenceReady } from '../../deploy/bloom/single-server-staging.mjs';

const model = 'enthusia-qwen3';
const secret = 'synthetic-not-real-model-key';
const active: Server[] = [];

async function mockModel(options: { model?: string; status?: string } = {}) {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + secret) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: options.status ?? 'ok' }));
    } else if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: options.model ?? model }] }));
    } else {
      res.writeHead(404).end();
    }
  });
  active.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unable to get ephemeral port');
  return address.port;
}

afterEach(async () => {
  for (const server of active.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

const alive = { exitCode: null, signalCode: null };

describe('managed inference loopback readiness', () => {
  it('checks health and exact model identity with an internal API key', async () => {
    const port = await mockModel();
    await expect(untilInferenceReady(port, model, secret, alive, 1000)).resolves.toBeUndefined();
  });

  it('never treats an unauthenticated model endpoint as ready', async () => {
    const port = await mockModel();
    await expect(untilInferenceReady(port, model, 'invalid', alive, 90))
      .rejects.toThrow('did not become ready');
  });

  it('never treats a different loaded model as verified', async () => {
    const port = await mockModel({ model: 'wrong-alias' });
    await expect(untilInferenceReady(port, model, secret, alive, 90))
      .rejects.toThrow('did not become ready');
  });

  it('rejects a model still warming up', async () => {
    const port = await mockModel({ status: 'loading model' });
    await expect(untilInferenceReady(port, model, secret, alive, 90))
      .rejects.toThrow('did not become ready');
  });

  it('fails immediately if the supervised model process has exited', async () => {
    await expect(untilInferenceReady(15123, model, secret, {
      exitCode: 1, signalCode: null,
    }, 1000)).rejects.toThrow('exited before readiness');
  });
});
