/**
 * Credential-free, offline Linux image smoke for the complete Agent + Gateway
 * startup path. A TEST-ONLY local HTTP fake reports one model for readiness.
 * No generation, tokens, Discord login, GitHub indexing, SFTP or network calls.
 *
 * Usage: node deploy/bloom/check-offline-supervisor.mjs
 */
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { planSingleServer, runSingleServer } from './single-server-staging.mjs';

async function freePort() {
  const server = createTcpServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const addr = server.address();
  const port = typeof addr === 'object' ? addr?.port : undefined;
  await new Promise((done) => server.close(done));
  if (!Number.isInteger(port)) throw new Error('Ephemeral loopback port unavailable');
  return port;
}

async function main() {
  const modelId = 'enthusia-synthetic-smoke';
  const mockedInference = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/v1/models') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'No generation in offline smoke' }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({
      object: 'list', data: [{ id: modelId, object: 'model', owned_by: 'synthetic-test' }],
    }));
  });
  await new Promise((done, fail) => {
    mockedInference.once('error', fail);
    mockedInference.listen(0, '127.0.0.1', done);
  });
  try {
    const addr = mockedInference.address();
    if (!addr || typeof addr === 'string') throw new Error('No model mock port');
    const modelPort = addr.port;
    const agentPort = await freePort();
    let gatewayPort = await freePort();
    while (new Set([modelPort, agentPort, gatewayPort]).size !== 3) {
      gatewayPort = await freePort();
    }
    const environment = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SYSTEMROOT: process.env.SYSTEMROOT,
      APPDATA: process.env.APPDATA,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      LANG: process.env.LANG,
      NODE_ENV: 'development',
      ENTHUSIA_BLOOM_STAGING: '1',
      ENTHUSIA_INFERENCE_BASE_URL: 'http://127.0.0.1:' + modelPort,
      ENTHUSIA_INFERENCE_MODEL: modelId,
      ENTHUSIA_AGENT_PORT: String(agentPort),
      ENTHUSIA_AI_GATEWAY_PORT: String(gatewayPort),
    };
    // The launcher itself requires an explicit isolated development opt-in
    // and forbids private integrations / managed indexer / Discord here.
    const plan = planSingleServer(['--smoke', '--without-discord'], environment);
    await runSingleServer(plan, environment);
    console.log('[bloom-linux-smoke] PASS: real Agent + Gateway ready and stopped cleanly.');
    console.log('[bloom-linux-smoke] MODEL IS FAKE. No inference, Discord or SFTP attempted.');
  } finally {
    await new Promise((done) => mockedInference.close(done));
  }
}

main().catch(() => {
  console.error('[bloom-linux-smoke] Failed to verify the isolated service startup.');
  process.exitCode = 1;
});
