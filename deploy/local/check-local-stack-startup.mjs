/**
 * Credential-free local startup smoke test: briefly starts only the agent and
 * gateway on loopback, using separate ephemeral OS-assigned ports and keys.
 * No Discord process, ticket endpoints, SFTP, model completion, or production.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..', '..');
const resolver = resolve(root, 'deploy/local/workspace-source-resolver.mjs');
const launched = [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function getFreePort() {
  const server = net.createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' ? address.port : null;
  await new Promise((done) => server.close(done));
  if (port === null) throw new Error('Could not select a local test port');
  return port;
}

function start(label, entry, env) {
  const child = spawn(process.execPath, [
    '--experimental-transform-types',
    '--import', pathToFileURL(resolver).href,
    resolve(root, entry),
  ], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (part) => {
      diagnostic += String(part).slice(0, 1800);
      diagnostic = diagnostic.slice(-4500);
    });
  }
  child.on('error', (error) => {
    diagnostic += String(error.message).slice(0, 1000);
  });
  const record = { label, child, diagnostic: () => diagnostic };
  launched.push(record);
  return record;
}

async function waitLive(record, port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (record.child.exitCode !== null) {
      throw new Error(record.label + ' exited before ready: ' + record.diagnostic());
    }
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health/live', {
        signal: AbortSignal.timeout(900),
      });
      if (response.status === 200) return;
    } catch {}
    await delay(250);
  }
  throw new Error(record.label + ' did not become ready: ' + record.diagnostic());
}

const safeKeys = new Set([
  'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'HOMEDRIVE', 'HOMEPATH', 'HOME', 'OS', 'LANG', 'TZ',
]);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  safeKeys.has(key.toUpperCase())));
const shared = {
  ...inherited,
  NODE_ENV: 'development',
  ENTHUSIA_LOCAL_BIND_HOST: '127.0.0.1',
  ENTHUSIA_SERVICE_NAME: 'enthusia-ai-startup-smoke',
  ENTHUSIA_LOG_LEVEL: 'warn',
  ENTHUSIA_INFERENCE_BASE_URL: 'http://127.0.0.1:11434',
  ENTHUSIA_INFERENCE_MODEL: 'qwen3:8b',
};
try {
  const agentPort = await getFreePort();
  let gatewayPort = await getFreePort();
  while (gatewayPort === agentPort) gatewayPort = await getFreePort();
  const agentKey = randomBytes(32).toString('hex');
  const gatewayKey = randomBytes(32).toString('hex');
  const agent = start('agent', 'apps/agent-service/dist/main.js', {
    ...shared, ENTHUSIA_AGENT_PORT: String(agentPort), ENTHUSIA_AGENT_API_KEYS: agentKey,
  });
  await waitLive(agent, agentPort);
  console.log('[smoke] Agent started and responded on 127.0.0.1.');
  const gateway = start('gateway', 'apps/ai-gateway/dist/main.js', {
    ...shared, ENTHUSIA_AI_GATEWAY_PORT: String(gatewayPort),
    ENTHUSIA_GATEWAY_API_KEYS: gatewayKey,
    ENTHUSIA_AGENT_BASE_URL: 'http://127.0.0.1:' + agentPort,
    ENTHUSIA_AGENT_API_KEY: agentKey,
    ENTHUSIA_GATEWAY_ALLOWED_SURFACES: 'discord',
  });
  await waitLive(gateway, gatewayPort);
  console.log('[smoke] Gateway started and responded on 127.0.0.1.');
  console.log('[smoke] No Discord login or model prompt was attempted.');
} finally {
  for (const record of launched.reverse()) {
    if (record.child.exitCode === null) record.child.kill();
  }
}
