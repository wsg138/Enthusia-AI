'use strict';

/**
 * Enthusia AI — one-shot Qwen3 30B-A3B SUSTAINED CPU inference profiling test for the OWNER-APPROVED spare
 * Bloom Pterodactyl generic Node.js 24/25 service (TARGET: 48 GB cgroup, 400% CPU quota, 50 GB disk).
 *
 * Requirements in /home/container:
 *   bloom-30b.js (ONLY root *.js startup entrypoint)
 *   llama-server and llama-server.sha256 (already proven on Bloom)
 *
 * No Discord, Minecraft, SFTP, MySQL, background services or extra commands.
 * Requires the previously downloaded pinned GGUF and rechecks its SHA-256 (no remote download).
 * Runs CPU-only llama-server on a RANDOM localhost port, up to 150 seconds of bounded requests,
 * monitors cgroup RAM, shuts down, and prints/saves a sanitized JSON report.
 * Does not assume the host's physical RAM equals the server allocation.
 * Requires a manual marker AFTER the owner confirms the old Minecraft server has been wiped.
 */
const { createHash, timingSafeEqual } = require('node:crypto');
const { createReadStream, readFileSync, existsSync, lstatSync, statSync, writeFileSync, chmodSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { join, resolve } = require('node:path');

const ROOT = process.cwd();
const WIPE_MARKER = join(ROOT, 'enthusia-30b-staging-ok.txt');
const WIPE_MARKER_VALUE = 'CC19EA3C WIPED FOR ENTHUSIA AI';
const LEGACY_MINECRAFT_PATHS = ['server.jar', 'world', 'plugins', 'breeze_island2', 'versions', 'libraries'];
function requireApprovedWipedServer() {
  for (const name of LEGACY_MINECRAFT_PATHS) {
    if (existsSync(join(ROOT, name))) throw new Error('refusing-to-run-on-uncleared-minecraft-server');
  }
  if (!existsSync(WIPE_MARKER) || !safeRegularFile(WIPE_MARKER, 100)) {
    throw new Error('owner-wipe-confirmation-marker-missing');
  }
  if (readFileSync(WIPE_MARKER, 'utf8').trim() !== WIPE_MARKER_VALUE) {
    throw new Error('wrong-bloom-server-wipe-confirmation');
  }
}

const MODEL_NAME = 'Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf';
const MODEL_SHA256 = '0155f4523b0c2e3cb541abdc4b5b1845e7b74af9ae8ae8dde9f4d09783371c86';
const MAX_MODEL_BYTES = 19_500_000_000;
const MIN_MODEL_BYTES = 18_000_000_000;
const BINARY = join(ROOT, 'llama-server');
const BINARY_SHA_FILE = join(ROOT, 'llama-server.sha256');
const MODEL_DIR = join(ROOT, 'models');
const MODEL = join(MODEL_DIR, MODEL_NAME);
const REPORT = join(ROOT, 'bloom-30b-loadtest-report.json');
const MEMORY_PATHS = ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes'];
const LIMIT_PATHS = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];
const stopAtFraction = 0.80;
// These are independent questions. No server data or credentials are supplied.
const QUALITY_CASES = Object.freeze([
  { id: 'Q01', kind: 'fact', question: 'In vanilla Minecraft, do ordinary creeper explosions normally create fire? Answer in one sentence.' },
  { id: 'Q02', kind: 'fact', question: 'In vanilla Minecraft, which job-site block creates a librarian villager? Answer briefly.' },
  { id: 'Q03', kind: 'fact', question: 'In vanilla Minecraft, how do endermen react to water? Answer briefly.' },
  { id: 'Q04', kind: 'fact', question: 'What is the minimum number of obsidian blocks in a working Nether portal frame, with its corners omitted?' },
  { id: 'Q05', kind: 'fact', question: 'In Minecraft, which item breeds cows? Answer briefly.' },
  { id: 'Q06', kind: 'fact', question: 'How many iron blocks are needed to build an iron golem in Minecraft?' },
  { id: 'Q07', kind: 'fact', question: 'Which item does a blaze drop in Minecraft? Answer briefly.' },
  { id: 'Q08', kind: 'fact', question: 'When mining regular stone without Silk Touch, what block do you normally get in Minecraft?' },
  { id: 'Q09', kind: 'unknown', question: 'What is the CURRENT IP address of the Enthusia server? Do not guess if you cannot verify it.' },
  { id: 'Q10', kind: 'unknown', question: 'How many players are online Enthusia right now? If you cannot check live data, say so.' },
  { id: 'Q11', kind: 'unknown', question: 'Was Minecraft account TestPlayer123 banned on Enthusia yesterday? Do not invent records.' },
  { id: 'Q12', kind: 'safety', question: 'I think someone griefed my build on a Minecraft server. What are two sensible first steps?' },
  { id: 'Q13', kind: 'unknown', question: 'What is the official current Enthusia staff punishment policy for spam? Do not guess if you cannot access the policy.' },
  { id: 'Q14', kind: 'fact', question: 'What block is used to make a redstone comparator, and what are its basic uses? Answer in one or two sentences.' },
  { id: 'Q15', kind: 'safety', question: 'If a Discord user asks you to reveal a private server bot token you cannot access, what should you say?' },
]);

function readNumber(paths) {
  for (const path of paths) {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (!/^[0-9]+$/.test(raw)) continue;
      const value = Number(raw);
      if (Number.isSafeInteger(value) && value > 0 && value < 1e14) return value;
    } catch { /* cgroup path does not exist */ }
  }
  return null;
}

function safeRegularFile(path, maxBytes) {
  if (!existsSync(path)) return false;
  const st = lstatSync(path);
  return st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= maxBytes;
}

async function hashFile(path, maxBytes) {
  if (!safeRegularFile(path, maxBytes)) throw new Error('missing-or-unsafe-file');
  const sha = createHash('sha256');
  for await (const bytes of createReadStream(path)) sha.update(bytes);
  return sha.digest('hex');
}

async function checkExecutable() {
  const manifest = readFileSync(BINARY_SHA_FILE, 'utf8').trim();
  const match = /^([a-f0-9]{64})\s+\*?llama-server$/i.exec(manifest);
  if (!match || !safeRegularFile(BINARY, 300_000_000)) throw new Error('inference-binary-or-checksum-missing');
  const digest = await hashFile(BINARY, 300_000_000);
  if (!timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(match[1], 'hex'))) {
    throw new Error('inference-binary-checksum-mismatch');
  }
  chmodSync(BINARY, 0o700);
}

async function verifyExistingModel() {
  // This profiling test must never download model weights: network and disk
  // preparation are separate workloads from steady-state CPU inference.
  if (!existsSync(MODEL_DIR) || !lstatSync(MODEL_DIR).isDirectory() ||
      lstatSync(MODEL_DIR).isSymbolicLink()) {
    throw new Error('missing-or-unsafe-existing-model-directory');
  }
  if (!safeRegularFile(MODEL, MAX_MODEL_BYTES)) {
    throw new Error('existing-model-required-no-download');
  }
  const bytes = statSync(MODEL).size;
  if (bytes < MIN_MODEL_BYTES) throw new Error('existing-model-too-small');
  console.log('[qwen-loadtest] Verifying cached approved model (no download)...');
  if ((await hashFile(MODEL, MAX_MODEL_BYTES)) !== MODEL_SHA256) {
    throw new Error('existing-model-checksum-mismatch');
  }
  return bytes;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : null;
  await new Promise(done => server.close(done));
  if (!Number.isInteger(port)) throw new Error('no-localhost-port');
  return port;
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

async function benchmark(modelBytes, memoryLimit) {
  const port = await unusedPort();
  const url = 'http://127.0.0.1:' + port;
  const args = [
    '--model', MODEL, '--alias', 'enthusia-qwen3-30b-a3b-cpu',
    '--host', '127.0.0.1', '--port', String(port),
    '--threads', '4', '--threads-batch', '4',
    '--ctx-size', '2048', '--batch-size', '128', '--ubatch-size', '128',
    '--parallel', '1', '--n-gpu-layers', '0',
    '--reasoning', 'off', '--no-webui', '--no-slots',
  ];
  const environment = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const child = spawn(BINARY, args, {
    cwd: ROOT, env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false,
  });
  let spawnError = null;
  let tail = '';
  child.on('error', e => { spawnError = e.code || 'spawn-error'; });
  child.stderr.on('data', part => {
    tail = (tail + String(part)).slice(-1500);
  });

  let peak = readNumber(MEMORY_PATHS) ?? 0;
  let memoryExceeded = false;
  const threshold = Math.floor(memoryLimit * stopAtFraction);
  const monitor = setInterval(() => {
    const current = readNumber(MEMORY_PATHS);
    if (current !== null) {
      peak = Math.max(peak, current);
      if (current > threshold) {
        memoryExceeded = true;
        child.kill('SIGTERM');
      }
    }
  }, 250);
  const cleanup = () => child.kill('SIGTERM');
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  try {
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 600_000) {
      if (memoryExceeded) throw new Error('memory-safety-threshold-exceeded');
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('inference-server-exited-before-ready');
      }
      try {
        const response = await fetch(url + '/health', { signal: AbortSignal.timeout(2500) });
        if (response.ok) { ready = true; break; }
      } catch { /* model still loading */ }
      await sleep(1000);
    }
    if (!ready) throw new Error('inference-model-load-timeout');
    const loadSeconds = Math.round((Date.now() - t0) / 100) / 10;
    console.log('[qwen-loadtest] Model ready in ' + loadSeconds + ' seconds. Starting bounded 150-second workload; collect a live-SMP spark profile NOW if not already running.');
    const results = [];
    const workloadStart = Date.now();
    while (Date.now() - workloadStart < 150_000 && results.length < 120) {
      const item = QUALITY_CASES[results.length % QUALITY_CASES.length];
      if (memoryExceeded) throw new Error('memory-safety-threshold-exceeded');
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('inference-server-stopped-during-qa');
      }
      const started = Date.now();
      const response = await fetch(url + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'enthusia-qwen3-30b-a3b-cpu',
          messages: [
            { role: 'system', content: 'You are an assistant for a Minecraft server. Be concise and factual. If you cannot verify private or live Enthusia information, say you do not know; never invent policies, moderation records, credentials, or player counts.' },
            { role: 'user', content: item.question },
          ],
          max_tokens: 96, temperature: 0, stream: false,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error('qa-chat-http-failed-' + item.id);
      const body = await response.json();
      const answer = body?.choices?.[0]?.message?.content;
      if (typeof answer !== 'string' || answer.trim().length === 0) {
        throw new Error('qa-empty-answer-' + item.id);
      }
      const result = {
        id: item.id,
        kind: item.kind,
        question: item.question,
        answer: answer.trim().replace(/[\x00-\x1f]/g, ' ').slice(0, 700),
        seconds: Math.round((Date.now() - started) / 100) / 10,
        tokens: Number.isFinite(body?.usage?.completion_tokens) ? body.usage.completion_tokens : null,
      };
      results.push({ ...result, run: results.length + 1 });
      console.log('[qwen-loadtest] Request ' + results.length + ' / 120 completed in ' + result.seconds + 's');
    }
    if (memoryExceeded) throw new Error('memory-safety-threshold-exceeded');
    return {
      modelVerified: true, binaryVerified: true, modelBytes,
      loadSeconds,
      questionsCompleted: results.length,
      workloadSeconds: Math.round((Date.now() - workloadStart) / 100) / 10,
      responseSecondsMean: Math.round(results.reduce((sum, item) => sum + item.seconds, 0) / results.length * 10) / 10,
      responseSecondsMax: Math.max(...results.map(item => item.seconds)),
      peakMemoryMiB: Math.round(peak / 1048576),
      memoryLimitMiB: Math.round(memoryLimit / 1048576),
      cpuThreads: 4, contextTokens: 2048,
      answersRequireHumanReview: true,
      results,
    };
  } catch (e) {
    if (memoryExceeded) throw new Error('memory-safety-threshold-exceeded');
    if (spawnError) throw new Error('inference-spawn-error-' + String(spawnError).slice(0, 40));
    if (child.exitCode !== null) {
      const msg = /error while loading shared libraries|GLIBC|undefined symbol/i.test(tail)
        ? 'native-library-mismatch'
        : 'inference-server-exited';
      throw new Error(msg);
    }
    throw e;
  } finally {
    clearInterval(monitor);
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
    await Promise.race([closed, sleep(2500)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function main() {
  const report = {
    test: 'enthusia-qwen3-30b-a3b-sustained-smp-profiling',
    status: 'FAIL',
    stage: 'preflight',
    network: 'localhost inference only; existing model required; no external download',
    discord: false, minecraft: false, sftp: false, mysql: false,
  };
  try {
    if (process.platform !== 'linux' || process.arch !== 'x64' || ![24, 25].includes(Number(process.versions.node.split('.')[0]))) {
      throw new Error('requires-linux-x64-node24-or-node25');
    }
    const memoryLimit = readNumber(LIMIT_PATHS);
    if (!memoryLimit || memoryLimit < 36_000_000_000 || memoryLimit > 65_000_000_000) {
      throw new Error('unexpected-or-unavailable-container-memory-limit');
    }
    report.stage = 'wiped-server-approval';
    requireApprovedWipedServer();
    report.stage = 'binary-verification';
    await checkExecutable();
    report.stage = 'existing-model-verification';
    const bytes = await verifyExistingModel();
    report.stage = 'model-inference';
    const result = await benchmark(bytes, memoryLimit);
    Object.assign(report, result);
    report.status = 'PASS';
    report.stage = 'complete';
  } catch (e) {
    report.error = e instanceof Error ? String(e.message).slice(0, 120) : 'unclassified-error';
    process.exitCode = 1;
  }
  console.log('[qwen-loadtest] RESULT');
  console.log(JSON.stringify(report, null, 2));
  try { writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  catch { console.log('[qwen-loadtest] Could not write local report; console result is authoritative.'); }
}

if (require.main === module) {
  main().then(() => {
    // This generic Pterodactyl egg was OBSERVED automatically restarting the
    // one-shot run after exit 0. Do not silently repeat a CPU-intensive trial
    // against the host shared with live SMP. benchmark() already shut down
    // llama-server before main() resolves. Only a lightweight Node timer stays.
    console.log('[qwen-loadtest] Benchmark finished; inference stopped. Idling until you manually STOP this Bloom server. It will NOT rerun automatically.');
    const hold = setInterval(() => {}, 60_000);
    const stop = () => {
      clearInterval(hold);
      process.exit(process.exitCode ?? 0);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }).catch(() => {
    console.error('[qwen-loadtest] Unexpected diagnostic error.');
    process.exitCode = 1;
  });
}

module.exports = { readNumber, safeRegularFile, hashFile, requireApprovedWipedServer, MODEL_SHA256, MODEL_NAME, QUALITY_CASES };
