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
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareManagedInference } from './managed-inference.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const EXPECTED_NODE_MAJOR = 24;
const allowedOptions = new Set(['--dry-run', '--smoke', '--with-discord', '--without-discord', '--managed-inference']);
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
  const managedInference = args.includes('--managed-inference');
  if (managedInference && [
    'ENTHUSIA_MODEL_PATH', 'ENTHUSIA_MODEL_SHA256',
    'ENTHUSIA_LLAMA_SERVER_PATH', 'ENTHUSIA_LLAMA_SERVER_SHA256',
  ].some((key) => !env[key])) {
    throw new Error('Managed inference requires a pinned model and llama-server executable');
  }
  if (args.includes('--smoke') && withDiscord) throw new Error('Smoke mode must never connect to Discord');
  if (withDiscord) {
    if (!env.DISCORD_BOT_TOKEN || !env.ENTHUSIA_DISCORD_ALLOWED_GUILD_IDS ||
        !env.ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS || !env.ENTHUSIA_DISCORD_SLASH_GUILD_ID) {
      throw new Error('Discord staging requires privately injected test bot token and exact test guild/channel restrictions');
    }
    if (env.ENTHUSIA_DISCORD_ALLOWED_GUILD_IDS !== '1552729865306767471' ||
        env.ENTHUSIA_DISCORD_SLASH_GUILD_ID !== '1552729865306767471' ||
        !/^\d{17,21}$/.test(env.ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS) ||
        env.ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS === '1552873662745546822') {
      throw new Error('Discord staging must use exactly one test guild and one test channel');
    }
  }

  const inferenceUrl = managedInference
    ? (env.ENTHUSIA_INFERENCE_BASE_URL ?? 'http://127.0.0.1:11434')
    : (env.ENTHUSIA_INFERENCE_BASE_URL ?? '');
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(inferenceUrl)) {
    throw new Error('Staging inference must be an explicitly configured local loopback HTTP endpoint');
  }
  const agentPort = parsePort(env.ENTHUSIA_AGENT_PORT, DEFAULT_AGENT_PORT);
  const gatewayPort = parsePort(env.ENTHUSIA_AI_GATEWAY_PORT, DEFAULT_GATEWAY_PORT);
  const inferencePort = Number(new URL(inferenceUrl).port);
  if (!Number.isInteger(inferencePort) || inferencePort < 1024 || inferencePort > 65535 ||
      agentPort === gatewayPort || inferencePort === agentPort ||
      inferencePort === gatewayPort) {
    throw new Error('Agent, Gateway and inference ports must be distinct');
  }
  const resolver = resolve(root, 'deploy/local/workspace-source-resolver.mjs');
  const paths = [
    ['agent', resolve(root, 'apps/agent-service/dist/main.js'), agentPort],
    ['gateway', resolve(root, 'apps/ai-gateway/dist/main.js'), gatewayPort],
    ...(withDiscord ? [['discord', resolve(root, 'apps/discord-bot/dist/main.js'), null]] : []),
  ];
  if (!args.includes('--dry-run')) {
    for (const [, entry] of paths) {
      if (!existsSync(entry)) throw new Error('Missing compiled service. Run npm build before staging.');
    }
    if (!existsSync(resolver)) throw new Error('Missing staged workspace resolver');
  }
  return {
    root, resolver, paths, agentPort, gatewayPort, inferenceUrl,
    withDiscord, managedInference, inferencePort, dryRun: args.includes('--dry-run'), smoke: args.includes('--smoke'),
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
  const inferenceKey = plan.managedInference ? randomBytes(32).toString('hex') : undefined;
  const common = {
    ...safeInheritedEnv(env),
    NODE_ENV: 'development',
    ENTHUSIA_LOG_LEVEL: 'warn',
    ENTHUSIA_LOCAL_BIND_HOST: '127.0.0.1',
    ENTHUSIA_INFERENCE_BASE_URL: plan.inferenceUrl,
    ENTHUSIA_INFERENCE_MODEL: env.ENTHUSIA_INFERENCE_MODEL || 'qwen3:8b',
    ENTHUSIA_INFERENCE_THINKING_MODE: 'disabled',
    ENTHUSIA_INFERENCE_MAX_CONTEXT_TOKENS: '8192',
    ENTHUSIA_INFERENCE_MAX_OUTPUT_TOKENS: '1400',
    ENTHUSIA_INFERENCE_CONCURRENCY: '1',
    ENTHUSIA_MAX_TOOL_CALLS_PER_TURN: '2',
  };
  const agent = {
    ...common,
    ENTHUSIA_SERVICE_NAME: 'enthusia-bloom-staging-agent',
    ENTHUSIA_AGENT_PORT: String(plan.agentPort),
    ENTHUSIA_AGENT_API_KEYS: agentKey,
    ...(inferenceKey ? { ENTHUSIA_INFERENCE_API_KEY: inferenceKey } : {}),
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
    ENTHUSIA_DISCORD_ALLOWED_GUILD_IDS: env.ENTHUSIA_DISCORD_ALLOWED_GUILD_IDS,
    ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS: env.ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS,
    ENTHUSIA_DISCORD_TEST_CHANNELS: '',
    ENTHUSIA_DISCORD_AI_CHANNELS: '',
    ENTHUSIA_DISCORD_STAFF_CHANNELS: '',
    ENTHUSIA_DISCORD_STAFF_ROLES: '',
    ENTHUSIA_DISCORD_USE_MOCK_GATEWAY: 'false',
    ENTHUSIA_DISCORD_SLASH_GUILD_ID: env.ENTHUSIA_DISCORD_SLASH_GUILD_ID,
    ENTHUSIA_DISCORD_SLASH_ONLY: 'false',
    ENTHUSIA_DISCORD_MENTION_ONLY: 'true',
    ENTHUSIA_DISCORD_GATEWAY_TIMEOUT_MS: '130000',
    ENTHUSIA_AI_GATEWAY_URL: 'http://127.0.0.1:' + plan.gatewayPort,
    ENTHUSIA_AI_GATEWAY_API_KEY: gatewayKey,
  };
  const inference = {
    ...safeInheritedEnv(env),
    ...(inferenceKey ? { LLAMA_API_KEY: inferenceKey } : {}),
  };
  return { agent, gateway, discord, inference };
}

function portOccupied(port) {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => { socket.destroy(); done(false); });
    socket.setTimeout(1000, () => { socket.destroy(); done(true); });
  });
}

async function untilReady(name, port, child, timeoutMs = 30000) {
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

export async function untilInferenceReady(port, modelName, apiKey, child, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Local model exited before readiness');
    }
    try {
      const baseUrl = 'http://127.0.0.1:' + port;
      const headers = { authorization: 'Bearer ' + apiKey };
      const res = await fetch(baseUrl + '/health', {
        headers, signal: AbortSignal.timeout(900),
      });
      if (res.ok) {
        const value = await res.json();
        if (value.status === 'ok') {
          // Readiness is tied to the verified, explicitly aliased local model,
          // not merely an arbitrary HTTP server responding on the port.
          const list = await fetch(baseUrl + '/v1/models', {
            headers, signal: AbortSignal.timeout(1200),
          });
          if (list.ok) {
            const catalog = await list.json();
            if (Array.isArray(catalog.data) &&
                catalog.data.some((item) => item.id === modelName)) return;
          }
        }
      }
    } catch { /* Model still loading; never log remote response bodies. */ }
    await wait(750);
  }
  throw new Error('Local model did not become ready before timeout');
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
  // Never attach to or kill an already-running Windows or Bloom service.
  if (await portOccupied(plan.agentPort) || await portOccupied(plan.gatewayPort) ||
      (plan.managedInference && await portOccupied(plan.inferencePort))) {
    throw new Error('One or more requested local service ports are already occupied');
  }
  // Hash checking must succeed BEFORE starting any child service.
  const model = plan.managedInference
    ? await prepareManagedInference(env, plan.inferencePort)
    : null;
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
    if (model) {
      // The binary and model hashes were checked above. Never pass the API
      // key in argv; llama.cpp reads LLAMA_API_KEY from the child environment.
      const child = spawn(model.executable, model.args, {
        cwd: plan.root, env: envs.inference, windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      children.push({ name: 'inference', child });
      child.on('error', () => {
        if (!stopping) { stopReason = 'inference launch failed'; notifyExit(); }
      });
      child.on('exit', () => {
        if (!stopping) { stopReason = 'inference exited unexpectedly'; notifyExit(); }
      });
      await Promise.race([
        untilInferenceReady(model.port, model.modelName, envs.inference.LLAMA_API_KEY, child),
        exited.then(() => { throw new Error(stopReason); }),
      ]);
      console.log('[bloom-staging] Pinned local inference runtime is ready.');
    }
    const agent = launch('agent', plan.paths[0][1], envs.agent);
    await Promise.race([untilReady('agent', plan.agentPort, agent), exited.then(() => { throw new Error(stopReason); })]);
    const gateway = launch('gateway', plan.paths[1][1], envs.gateway);
    await Promise.race([untilReady('gateway', plan.gatewayPort, gateway), exited.then(() => { throw new Error(stopReason); })]);
    if (plan.withDiscord) launch('discord', plan.paths[2][1], envs.discord);
    console.log('[bloom-staging] Agent and Gateway ready; Discord=' + (plan.withDiscord ? 'enabled' : 'disabled'));
    console.log('[bloom-staging] Inference=' + (model ? 'supervised, pinned local' : 'existing local loopback') +
      '; SFTP and private integrations are OFF.');
    if (plan.smoke) {
      stopReason = 'smoke complete';
      return;
    }
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
      console.log('[bloom-staging] Dry run validated. Services: ' +
        (plan.managedInference ? 'pinned inference, ' : '') + 'agent, gateway' +
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
