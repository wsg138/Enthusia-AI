/**
 * Credential-free real local service smoke for the single-Bloom supervisor.
 * Starts Agent + Gateway ONLY on automatically selected localhost ports.
 * Never logs in to Discord, writes a config, invokes SFTP or deploys to Bloom.
 *
 * Usage: node deploy/bloom/check-single-staging.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcher = resolve(root, 'deploy/bloom/single-server-staging.mjs');

async function freePort() {
  const server = net.createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address()?.port;
  await new Promise((done) => server.close(done));
  if (!Number.isInteger(port)) throw new Error('Could not select a free test port');
  return port;
}

const os = Object.fromEntries([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'LANG', 'TZ',
].filter((n) => process.env[n]).map((n) => [n, process.env[n]]));

try {
  const probe = await fetch('http://127.0.0.1:11434/api/tags', {
    signal: AbortSignal.timeout(3500),
  });
  if (!probe.ok) throw new Error('Local Ollama endpoint unavailable');
  const models = await probe.json();
  if (!models.models?.some((m) => m.name === 'qwen3:8b')) {
    throw new Error('Local Ollama does not have the expected Qwen3:8b model');
  }
  const agentPort = await freePort();
  let gatewayPort = await freePort();
  while (gatewayPort === agentPort) gatewayPort = await freePort();
  const env = {
    ...os,
    NODE_ENV: 'development',
    ENTHUSIA_BLOOM_STAGING: '1',
    ENTHUSIA_INFERENCE_BASE_URL: 'http://127.0.0.1:11434',
    ENTHUSIA_INFERENCE_MODEL: 'qwen3:8b',
    ENTHUSIA_AGENT_PORT: String(agentPort),
    ENTHUSIA_AI_GATEWAY_PORT: String(gatewayPort),
  };
  const child = spawn(process.execPath, [launcher, '--smoke', '--without-discord'], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    stdout = stdout.slice(-6500);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
    stderr = stderr.slice(-6500);
  });
  const completed = new Promise((done) => child.once('close', done));
  const timer = setTimeout(() => child.kill(), 55000);
  try {
    const status = await completed;
    if (status !== 0 || !stdout.includes('Agent and Gateway ready')) {
      throw new Error('Supervisor smoke did not reach readiness: ' +
        stdout.replace(/[\r\n]+/g, ' ').slice(-500) + ' ' +
        stderr.replace(/[\r\n]+/g, ' ').slice(-500));
    }
    console.log('[bloom-smoke] PASS: Agent + Gateway started and stopped cleanly on unused localhost ports.');
    console.log('[bloom-smoke] Discord login: not attempted. SFTP and private tools: not connected.');
    console.log('[bloom-smoke] No Bloom/SMP/production change made.');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
} catch (error) {
  console.error('[bloom-smoke] ' + (error instanceof Error ? error.message : 'Unknown failure'));
  process.exitCode = 1;
}
