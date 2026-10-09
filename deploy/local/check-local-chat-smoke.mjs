/**
 * Credential-free local startup smoke test: briefly starts only the agent and
 * gateway on loopback, using separate ephemeral OS-assigned ports and keys.
 * No Discord process, ticket endpoints, SFTP, or production. Makes exactly\n * one opt-in synthetic model request via the local gateway.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..', '..');
const resolver = resolve(root, 'deploy/local/workspace-source-resolver.mjs');
const launched = [];
const publicDocs = process.argv.includes('--public-docs');
const warzone = process.argv.includes('--warzone');
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

async function checkReady(label, port) {
  const response = await fetch('http://127.0.0.1:' + port + '/health/ready', {
    signal: AbortSignal.timeout(5000),
  });
  const health = await response.json();
  if (!response.ok || health.status !== 'ok') {
    throw new Error(label + ' reported unready: HTTP ' + response.status +
      ', state ' + String(health.status));
  }
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
  ENTHUSIA_INFERENCE_THINKING_MODE: 'disabled',
  ENTHUSIA_INFERENCE_MAX_CONTEXT_TOKENS: '8192',
  ENTHUSIA_INFERENCE_MAX_OUTPUT_TOKENS: '1400',
  ENTHUSIA_INFERENCE_CONCURRENCY: '1',
  ENTHUSIA_MAX_TOOL_CALLS_PER_TURN: '2',
};
try {
  const agentPort = await getFreePort();
  let gatewayPort = await getFreePort();
  while (gatewayPort === agentPort) gatewayPort = await getFreePort();
  const agentKey = randomBytes(32).toString('hex');
  const gatewayKey = randomBytes(32).toString('hex');
  const agent = start('agent', 'apps/agent-service/dist/main.js', {
    ...shared, ENTHUSIA_AGENT_PORT: String(agentPort), ENTHUSIA_AGENT_API_KEYS: agentKey,
    ENTHUSIA_TEST_PIECLOAK_PUBLIC_DOCS: (publicDocs || warzone) ? '1' : '0',
  });
  await waitLive(agent, agentPort);
  await checkReady('agent', agentPort);
  console.log('[smoke] Agent started and responded on 127.0.0.1.');
  const gateway = start('gateway', 'apps/ai-gateway/dist/main.js', {
    ...shared, ENTHUSIA_AI_GATEWAY_PORT: String(gatewayPort),
    ENTHUSIA_GATEWAY_API_KEYS: gatewayKey,
    ENTHUSIA_AGENT_BASE_URL: 'http://127.0.0.1:' + agentPort,
    ENTHUSIA_AGENT_API_KEY: agentKey,
    ENTHUSIA_GATEWAY_ALLOWED_SURFACES: 'discord',
    ENTHUSIA_GATEWAY_AGENT_TIMEOUT_MS: '150000',
  });
  await waitLive(gateway, gatewayPort);
  await checkReady('gateway', gatewayPort);
  console.log('[smoke] Gateway started and responded on 127.0.0.1.');
  // One benign public test question, completely separate from Discord.
  const { Visibility } = await import('@enthusia/contracts');
  const startedAt = Date.now();
  const response = await fetch('http://127.0.0.1:' + gatewayPort + '/v1/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + gatewayKey,
    },
    body: JSON.stringify({
      surface: 'discord',
      actor: { id: '100000000000000000', type: 'player', displayName: 'Local smoke' },
      conversationId: 'discord:local-test:ai-testing',
      message: publicDocs ? 'How does the pie cloak system work on the server?' :
        warzone ? 'Can you explain how the warzones combat rotator system works' : 'What can you do?',
      visibilityCeiling: Visibility.PUBLIC,
      context: { trigger: warzone ? 'mention' : 'slash', isStaff: false,
        channelId: 'local-test', guildId: 'local-test-guild',
        messageId: 'local-test-message', channelKind: 'guild-text' },
    }),
    signal: AbortSignal.timeout(155000),
  });
  const payload = await response.json();
  console.log('[smoke] HTTP ' + response.status + '; time ' + (Date.now() - startedAt) + 'ms');
  if (!response.ok) {
    const code = payload?.error?.code ?? 'HTTP_FAILURE';
    console.log('[smoke] error code: ' + String(code).slice(0,100));
    throw new Error('Gateway rejected the synthetic local request');
  }
  console.log('[smoke] Answer: ' + String(payload.text ?? '').slice(0, 900));
  if (payload.escalation?.reason) {
    // This is diagnostic information only: never send it to Discord.
    console.log('[smoke] Internal failure reason: ' + String(payload.escalation.reason).slice(0, 900));
  }
  if (String(payload.text ?? '').includes('Something went wrong while handling your request')) {
    throw new Error('Orchestrator returned its built-in failure fallback');
  }
  if (warzone && (!String(payload.text ?? '').includes('github.com/wsg138/MaceGuard/blob/') ||
      !String(payload.text ?? '').includes('documented features') ||
      !Array.isArray(payload.sources) || payload.sources.length !== 1 ||
      payload.outcome !== 'answered')) {
    throw new Error('Warzone public-source answer is not grounded and complete.');
  }
  if (publicDocs && (!String(payload.text ?? '').includes('github.com/wsg138/PieCloak/blob/') ||
      !String(payload.text ?? '').includes('documented settings') ||
      !Array.isArray(payload.sources) || payload.sources.length !== 1)) {
    throw new Error('The public-source answer lacks a verified GitHub commit/source.');
  }
  console.log(publicDocs || warzone
    ? '[smoke] Verified public README reached the local Agent and Gateway without Discord.'
    : '[smoke] One synthetic end-to-end model request completed without Discord.');
} finally {
  for (const record of launched.reverse()) {
    if (record.child.exitCode === null) record.child.kill();
  }
}
