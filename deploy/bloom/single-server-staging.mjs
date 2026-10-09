/**
 * W21 single-Bloom-server STAGING supervisor. PREPARE ONLY, not deployment.
 *
 * One Pterodactyl process tree for Agent + Gateway + optionally Discord.
 * Inference is an explicitly configured, pre-existing LOCAL endpoint for this
 * early stage; the model worker and durable indexer are NOT packaged yet.
 *
 * Start manually from a trusted Node 24 install only after review. This
 * script never imports a Pterodactyl token, connects SFTP, or changes SMP.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const EXPECTED_NODE_MAJOR = 24;
const allowedOptions = new Set(['--dry-run', '--with-discord', '--without-discord']);
const DEFAULT_AGENT_PORT = 4200;
const DEFAULT_GATEWAY_PORT = 4100;
const STOP_GRACE_MS = 6000;

function parsePort(value, fallback) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error('Invalid local port (must be an integer between 1024 and 65535)');
  }
  return n;
}

export function planSingleServer(args = process.argv.slice(2), env = process.env) {
  for (const arg of args) if (!allowedOptions.has(arg)) throw new Error('Unknown staging argument');
  if (args.includes('--with-discord') && args.includes('--without-discord')) {
    throw new Error('Conflicting Discord staging arguments');
  }
  if (env.NODE_ENV !== 'development' || env.ENTHUSIA_BLOOM_STAGING !== '1') {
    throw new Error('Single-server staging requires NODE_ENV=development and ENTHUSIA_BLOOM_STAGING=1');
  }
  if (Number(process.versions.node.split('.')[0]) !== EXPECTED_NODE_MAJOR) {
    throw new Error('Single-server staging requires Node 24 (not the old Bloom Node 22 template)');
  }
  if (env.ENTHUSIA_AGENT_SFTP_CONFIG_PATH || env.ENTHUSIA_AGENT_TICKET_BOT_BASE_URL ||
      env.ENTHUSIA_AGENT_STAFF_MODERATION_BASE_URL || env.ENTHUSIA_AGENT_AI_MODERATION_BASE_URL ||
      env.ENTHUSIA_AGENT_MEMORY_PATH || env.ENTHUSIA_AGENT_POLICY_SERVER_ID) {
    throw new Error('Private/live integrations must be disabled for the staging supervisor');
  }

  const withDiscord = args.includes('--with-discord');
  if (withDiscord) {
    if (!env.DISCORD_BOT_TOKEN || !env.ENTHUSIA_DISCORD_TEST_GUILDS ||
        !env.ENTHUSIA_DISCORD_TEST_CHANNELS || !env.ENTHUSIA_DISCORD_SLASH_GUILD_ID) {
      throw new Error('Discord staging requires privately injected test bot token and exact test guild/channel restrictions');
    }
    if (env.ENTHUSIA_DISCORD_TEST_GUILDS.includes(',') ||
        env.ENTHUSIA_DISCORD_TEST_CHANNELS.includes(',')) {
      throw new Error('Discord staging must use exactly one test guild and one test channel');
    }
  }

  const inferenceUrl = env.ENTHUSIA_INFERENCE_BASE_URL ?? '';
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(inferenceUrl)) {
    throw new Error('Staging inference must be an explicitly configured local loopback HTTP endpoint');
  }
  const agentPort = parsePort(env.ENTHUSIA_AGENT_PORT, DEFAULT_AGENT_PORT);
  const gatewayPort = parsePort(env.ENTHUSIA_AI_GATEWAY_PORT, DEFAULT_GATEWAY_PORT);
  if (agentPort === gatewayPort || inferenceUrl === 'http://127.0.0.1:' + agentPort ||
      inferenceUrl === 'http://127.0.0.1:' + gatewayPort) {
    throw new Error('Agent, Gateway and inference ports must be distinct');
  }
  const resolver = resolve(root, 'deploy/local/workspace-source-resolver.mjs');
  const paths = [
    ['agent', resolve(root, 'apps/agent-service/dist/main.js'), agentPort],
    ['gateway', resolve(root, 'apps/ai-gateway/dist/main.js'), gatewayPort],
    ...(withDiscord ? [['discord', resolve(root, 'apps/discord-bot/src/main.ts'), null]] : []),
  ];
  for (const [, path] of paths) {
    if (!existsSync(path)) throw new Error('Missing compiled service. Run npm build before staging.');
  }
  if (!existsSync(resolver)) throw new Error('Missing staged workspace resolver');
  return {
    root, resolver, paths, agentPort, gatewayPort, inferenceUrl,
    withDiscord, dryRun: args.includes('--dry-run'),
  };
}

function safeInheritedEnv(env) {
  const keys = [
    'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'APPDATA',
    'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'TZ',
  ];
  return Object.fromEntries(keys.filter((key) => env[key] !== undefined)
    .map((key) => [key, env[key]]));
}

/** Only explicit allowlist variables can reach child processes. */
export function makeStagingEnvironments(plan, env = process.env) {
  const agentKey = randomBytes(32).toString('hex');
  const gatewayKey = randomBytes(32).toString('hex');
  const common = {
    ...safeInheritedEnv(env),
    NODE_ENV: 'development',
    ENTHUSIA_LOG_LEVEL: 'warn',
    ENTHUSIA_INFERENCE_BASE_URL: plan.inferenceUrl,
    ENTHUSIA_INFERENCE_MODEL: env.ENTHUSIA_INFERENCE_MODEL || 'qwen3:8b',
    ENTHUSIA_INFERENCE_THINKING_MODE: 'disabled',
    ENTHUSIA_INFERENCE_MAX_CONTEXT_TOKENS: '8192',
    ENTHUSIA_INFERENCE_MAX_OUTPUT_TOKENS: '1400',
    ENTHUSIA_INFERENCE_CONCURRENCY: '1',
  };
  const agent = {
    ...common,
    ENTHUSIA_SERVICE_NAME: 'enthusia-bloom-staging-agent',
    ENTHUSIA_AGENT_PORT: String(plan.agentPort),
    ENTHUSIA_AGENT_API_KEYS: agentKey,
    ENTHUSIA_TEST_PIECLOAK_PUBLIC_DOCS: '1',
  };
  const gateway = {
    ...common,
    ENTHUSIA_SERVICE_NAME: 'enthusia-bloom-staging-gateway',
    ENTHUSIA_AI_GATEWAY_PORT: String(plan.gatewayPort),
    ENTHUSIA_GATEWAY_API_KEYS: gatewayKey,
    ENTHUSIA_GATEWAY_ALLOWED_SURFACES: 'discord',
    ENTHUSIA_GATEWAY_AGENT_TIMEOUT_MS: '120000',
    ENTHUSIA_AGENT_BASE_URL: 'http://127.0.0.1:' + plan.agentPort,
    ENTHUSIA_AGENT_API_KEY: agentKey,
  };
  const discord = {
    ...common,
    ENTHUSIA_SERVICE_NAME: 'enthusia-bloom-staging-discord',
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    ENTHUSIA_DISCORD_ALLOWED_GUILDS: env.ENTHUSIA_DISCORD_TEST_GUILDS,
    ENTHUSIA_DISCORD_ALLOWED_CHANNELS: env.ENTHUSIA_DISCORD_TEST_CHANNELS,
    ENTHUSIA_DISCORD_SLASH_GUILD_ID: env.ENTHUSIA_DISCORD_SLASH_GUILD_ID,
    ENTHUSIA_DISCORD_SLASH_ONLY: 'false',
    ENTHUSIA_DISCORD_MENTION_ONLY: 'true',
    ENTHUSIA_DISCORD_GATEWAY_TIMEOUT_MS: '130000',
    ENTHUSIA_AI_GATEWAY_BASE_URL: 'http://127.0.0.1:' + plan.gatewayPort,
    ENTHUSIA_AI_GATEWAY_API_KEY: gatewayKey,
  };
  return { agent, gateway, discord };
}

async function untilReady(name, port, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(name + ' exited before readiness');
    }
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health/ready', {
        signal: AbortSignal.timeout(900),
      });
      if (response.ok) {
        const result = await response.json();
        if (result.status === 'ok') return;
      }
    } catch { /* Not yet available. */ }
    await wait(300);
  }
  throw new Error(name + ' did not become ready before timeout');
}

async function stopAll(children) {
  for (const entry of [...children].reverse()) {
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      entry.child.kill('SIGTERM');
    }
  }
  await Promise.race([
    Promise.all(children.map(({ child }) => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise((resolveDone) => child.once('exit', resolveDone)))),
    wait(STOP_GRACE_MS),
  ]);
  for (const entry of children) {
    if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
  }
}

export async function runSingleServer(plan, env = process.env) {
  const envs = makeStagingEnvironments(plan, env);
  const children = [];
  let stopping = false;
  let stopReason = 'stopped';
  let notifyExit;
  const exited = new Promise((done) => { notifyExit = done; });

  const onSigTerm = () => { stopReason = 'SIGTERM'; notifyExit(); };
  const onSigInt = () => { stopReason = 'SIGINT'; notifyExit(); };
  process.on('SIGTERM', onSigTerm);
  process.on('SIGINT', onSigInt);

  function launch(name, entry, serviceEnv) {
    const flags = [
      '--experimental-transform-types',
      '--import', pathToFileURL(plan.resolver).href,
      entry,
    ];
    const child = spawn(process.execPath, flags, {
      cwd: plan.root, env: serviceEnv, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    const record = { name, child };
    children.push(record);
    child.on('error', () => {
      if (!stopping) { stopReason = name + ' launch failed'; notifyExit(); }
    });
    child.on('exit', () => {
      if (!stopping) { stopReason = name + ' exited unexpectedly'; notifyExit(); }
    });
    return child;
  }

  try {
    const agent = launch('agent', plan.paths[0][1], envs.agent);
    await Promise.race([untilReady('agent', plan.agentPort, agent), exited.then(() => { throw new Error(stopReason); })]);
    const gateway = launch('gateway', plan.paths[1][1], envs.gateway);
    await Promise.race([untilReady('gateway', plan.gatewayPort, gateway), exited.then(() => { throw new Error(stopReason); })]);
    if (plan.withDiscord) launch('discord', plan.paths[2][1], envs.discord);
    console.log('[bloom-staging] Agent and Gateway ready; Discord=' + (plan.withDiscord ? 'enabled' : 'disabled'));
    console.log('[bloom-staging] External inference stays on local loopback; SFTP and private integrations are OFF.');
    await exited;
    if (stopReason.includes('unexpected') || stopReason.includes('failed')) throw new Error(stopReason);
  } finally {
    stopping = true;
    await stopAll(children);
    process.off('SIGTERM', onSigTerm);
    process.off('SIGINT', onSigInt);
  }
}

const invokedAsMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  try {
    const plan = planSingleServer();
    if (plan.dryRun) {
      console.log('[bloom-staging] Dry run validated. Services: agent, gateway' +
        (plan.withDiscord ? ', Discord' : '') + '.');
      console.log('[bloom-staging] No processes started, no credentials read aloud, no SFTP or SMP changes.');
    } else {
      await runSingleServer(plan);
    }
  } catch (error) {
    // Never dump environment or process arguments that may contain secrets.
    console.error('[bloom-staging] ' + (error instanceof Error ? error.message : 'Failed'));
    process.exitCode = 1;
  }
}
