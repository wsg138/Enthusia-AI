/**
 * Run Enthusia AI locally in exactly ONE owner-approved Discord test guild/channel.
 * Uses existing Ollama Qwen3 8B; no AI model training, Ticket Bot tools or prod.
 * Run from a private PowerShell with DISCORD_BOT_TOKEN in its process environment.
 * Never writes the Discord token or generated service keys to disk.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_GUILD = '1552729865306767471';
const TICKET_LOGS = '1552873662745546822';
const root = resolve(import.meta.dirname, '..', '..');
let channel = (process.env.ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS ?? '').trim();
const token = process.env.DISCORD_BOT_TOKEN;
const launched = [];
const secureId = (value) => /^\d{17,21}$/.test(value);

async function main() {
  if (!token || token.trim().length < 20) {
    throw new Error('Missing local DISCORD_BOT_TOKEN. Enter it in your current private PowerShell.');
  }
  if (channel === '') channel = await locateTestChannel(token);
  if (!secureId(channel) || channel === TICKET_LOGS || channel.includes(',')) {
    throw new Error('Invalid AI channel ID; the known ticket-logs channel is forbidden.');
  }
  if (process.env.ENTHUSIA_DISCORD_SLASH_GUILD_ID &&
    process.env.ENTHUSIA_DISCORD_SLASH_GUILD_ID !== TEST_GUILD) {
    throw new Error('Unexpected Discord guild selection; refusing any other guild.');
  }
  for (const filepath of [
    'apps/agent-service/dist/main.js',
    'apps/ai-gateway/dist/main.js',
    'apps/discord-bot/dist/main.js',
  ]) {
    await access(resolve(root, filepath));
  }

  for (const port of [4200, 4100]) {
    if (await portInUse(port)) throw new Error('Local port ' + port + ' is already occupied; nothing will be stopped or replaced.');
  }
  const health = await getJson('http://127.0.0.1:11434/api/tags', 3500);
  const installed = (health.models ?? []).some((m) => m.name === 'qwen3:8b');
  if (!installed) throw new Error('Ollama Qwen3 8B is not available locally.');

  // Pass only OS/runtime variables, never arbitrary inherited secrets.
  const allowedEnvironment = new Set([
    'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'HOMEDRIVE', 'HOMEPATH', 'HOME', 'OS', 'LANG', 'TZ',
  ]);
  const safe = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase())),
  );
  const shared = {
    ...safe,
    NODE_ENV: 'development',
    ENTHUSIA_LOCAL_BIND_HOST: '127.0.0.1',
    ENTHUSIA_SERVICE_NAME: 'enthusia-ai-local-test',
    ENTHUSIA_LOG_LEVEL: 'warn',
    ENTHUSIA_INFERENCE_BASE_URL: 'http://127.0.0.1:11434',
    ENTHUSIA_INFERENCE_MODEL: 'qwen3:8b',
    ENTHUSIA_INFERENCE_THINKING_MODE: 'disabled',
    ENTHUSIA_INFERENCE_MAX_CONTEXT_TOKENS: '8192',
    ENTHUSIA_INFERENCE_MAX_OUTPUT_TOKENS: '1400',
    ENTHUSIA_INFERENCE_CONCURRENCY: '1',
    ENTHUSIA_MAX_TOOL_CALLS_PER_TURN: '2',
  };
  const keyAgent = randomBytes(32).toString('hex');
  const keyGateway = randomBytes(32).toString('hex');

  spawnChild('agent', 'apps/agent-service/dist/main.js', {
    ...shared,
    ENTHUSIA_AGENT_PORT: '4200',
    ENTHUSIA_AGENT_API_KEYS: keyAgent,
    ENTHUSIA_TEST_PIECLOAK_PUBLIC_DOCS: '1',
  });
  await waitReady('http://127.0.0.1:4200/health/ready', launched[0], 30000);
  console.log('[test] Agent ready. Only opt-in public PieCloak and Warzones docs are enabled; no private/live server tools.');

  spawnChild('gateway', 'apps/ai-gateway/dist/main.js', {
    ...shared,
    ENTHUSIA_AI_GATEWAY_PORT: '4100',
    ENTHUSIA_GATEWAY_API_KEYS: keyGateway,
    ENTHUSIA_AGENT_BASE_URL: 'http://127.0.0.1:4200',
    ENTHUSIA_AGENT_API_KEY: keyAgent,
    ENTHUSIA_GATEWAY_ALLOWED_SURFACES: 'discord',
    ENTHUSIA_GATEWAY_AGENT_TIMEOUT_MS: '120000',
  });
  await waitReady('http://127.0.0.1:4100/health/ready', launched[1], 30000);

  console.log('[test] Starting Discord adapter; only your selected testing channel can receive replies.');
  const bot = spawnChild('discord', 'apps/discord-bot/dist/main.js', {
    ...shared,
    ENTHUSIA_AI_GATEWAY_URL: 'http://127.0.0.1:4100',
    ENTHUSIA_AI_GATEWAY_API_KEY: keyGateway,
    ENTHUSIA_DISCORD_SLASH_GUILD_ID: TEST_GUILD,
    ENTHUSIA_DISCORD_ALLOWED_GUILD_IDS: TEST_GUILD,
    ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS: channel,
    ENTHUSIA_DISCORD_TEST_CHANNELS: '',
    ENTHUSIA_DISCORD_AI_CHANNELS: '',
    ENTHUSIA_DISCORD_STAFF_CHANNELS: '',
    ENTHUSIA_DISCORD_STAFF_ROLES: '',
    ENTHUSIA_DISCORD_USE_MOCK_GATEWAY: 'false',
    // The isolated Agent may use most of its 120s deadline for local Qwen3.
    // The Discord client must outlive the Gateway's own timeout.
    ENTHUSIA_DISCORD_GATEWAY_TIMEOUT_MS: '130000',
    ENTHUSIA_DISCORD_SLASH_ONLY: 'false',
    ENTHUSIA_DISCORD_MENTION_ONLY: 'true',
    DISCORD_BOT_TOKEN: token,
  });
  // Clear the runner's own env copy after passing it to the Discord child.
  delete process.env.DISCORD_BOT_TOKEN;
  console.log('[test] Connect in #ai-testing and try: /ai ask question: What can you do?');
  console.log('[test] Press Ctrl+C to stop the three locally launched services.');
  await new Promise((resolveDone) => {
    bot.once('exit', (code) => {
      console.error('[test] Discord service exited (' + code + ').');
      resolveDone();
    });
  });
}

async function locateTestChannel(botToken) {
  // Read-only Discord metadata lookup. No messages, channel edits or token logs.
  const response = await fetch(
    'https://discord.com/api/v10/guilds/' + TEST_GUILD + '/channels',
    { headers: { Authorization: 'Bot ' + botToken },
      signal: AbortSignal.timeout(12000) },
  );
  if (!response.ok) {
    throw new Error('Discord cannot list test channels (HTTP ' + response.status +
      '). Set ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS manually to #ai-testing.');
  }
  const entries = await response.json();
  if (!Array.isArray(entries)) throw new Error('Discord returned invalid channel metadata.');
  const matches = entries.filter((entry) => entry.name === 'ai-testing' && entry.type === 0);
  if (matches.length !== 1 || !secureId(String(matches[0]?.id ?? ''))) {
    throw new Error('Create exactly one text channel called #ai-testing in the test guild.');
  }
  return matches[0].id;
}

function spawnChild(label, entry, env) {
  // The local agent imports workspace packages that still export .ts source
  // with .js relative specifiers. The test-only resolver handles these under
  // Node 24 without touching production packages or changing builds.
  const resolver = resolve(root, 'deploy/local/workspace-source-resolver.mjs');
  const child = spawn(process.execPath, ['--experimental-transform-types', '--import', pathToFileURL(resolver).href, resolve(root, entry)], {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', (error) => console.error('[test] ' + label + ' could not start:', error.message));
  launched.push(child);
  return child;
}
async function getJson(url, ms = 2500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!response.ok) throw new Error('Health request failed with HTTP ' + response.status);
  return response.json();
}
async function waitReady(url, processHandle, maxMs) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    if (processHandle.exitCode !== null) throw new Error('Local service exited during startup');
    try {
      const result = await getJson(url);
      if (result.status === 'ok') return;
    } catch {}
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 700));
  }
  throw new Error('Local service did not report ready before timeout: ' + url);
}
function portInUse(port) {
  return new Promise((resolveDone) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolveDone(true); });
    s.once('error', () => { s.destroy(); resolveDone(false); });
    s.setTimeout(1300, () => { s.destroy(); resolveDone(true); });
  });
}

let shuttingDown = false;
function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [...launched].reverse()) {
    if (child.exitCode === null) child.kill();
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopAll();
  process.exitCode = 0;
});
try {
  await main();
} catch (error) {
  console.error('[test] Start failed:', error?.message ?? String(error));
  process.exitCode = 1;
} finally {
  stopAll();
}
