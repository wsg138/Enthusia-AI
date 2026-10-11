/**
 * Enthusia AI: one-shot Bloom node.js generic capability check.
 *
 * SAFE BY DESIGN:
 *   - Zero network calls, credentials, Discord login, model downloads or SFTP.
 *   - Does not enumerate environment variables, user files or running processes.
 *   - Writes only one temporary file and one temporary copy of /bin/true
 *     inside a freshly created .enthusia-bloom-probe-* directory in the CWD.
 *   - Removes that directory on completion; never modifies server settings.
 *
 * Run from a disposable Bloom test server:
 *   node deploy/bloom/probe-node-generic.mjs
 * Output is one JSON report with ONLY allowlisted non-secret fields.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { platform, arch, totalmem } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ONE_GIB = 1024 ** 3;

export function parseMemoryLimit(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!/^[0-9]+$/.test(raw)) return null;
  const bytes = Number(raw);
  // Some cgroup v1 hosts use huge sentinel values to indicate 'unlimited'.
  return Number.isSafeInteger(bytes) && bytes >= 1024 * 1024 &&
    bytes <= 1024 ** 5 ? bytes : null;
}

export function parseCpuQuota(value) {
  if (typeof value !== 'string') return null;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 2 || fields[0] === 'max') return null;
  const quota = Number(fields[0]);
  const period = Number(fields[1]);
  if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(period) ||
      quota <= 0 || period <= 0) return null;
  return Math.round((quota / period) * 100) / 100;
}

async function readText(path) {
  try { return (await readFile(path, 'utf8')).trim(); }
  catch { return null; }
}

async function linuxLimits() {
  if (platform() !== 'linux') return { memoryBytes: null, cpuCores: null, source: 'not-linux' };
  const memory = (await readText('/sys/fs/cgroup/memory.max')) ??
    (await readText('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  const cpu = await readText('/sys/fs/cgroup/cpu.max');
  const cpuV1Quota = await readText('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const cpuV1Period = await readText('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  return {
    memoryBytes: parseMemoryLimit(memory),
    cpuCores: parseCpuQuota(cpu ?? (cpuV1Quota && cpuV1Period
      ? cpuV1Quota + ' ' + cpuV1Period : null)),
    source: memory !== null || cpu !== null ? 'cgroup' : 'not-exposed',
  };
}

function safeSpawn(file, args = []) {
  try {
    const result = spawnSync(file, args, {
      shell: false,
      windowsHide: true,
      timeout: 2500,
      stdio: 'ignore',
      env: {},
    });
    return result.status === 0 && !result.error;
  } catch { return false; }
}

export async function runProbe() {
  const report = {
    probe: 'enthusia-bloom-node-generic-v1',
    linux: platform() === 'linux',
    platform: platform(),
    architecture: arch(),
    nodeMajor: Number(process.versions.node.split('.')[0]),
    node24Compatible: Number(process.versions.node.split('.')[0]) === 24,
    nodeChildProcessesWork: safeSpawn(process.execPath, ['--version']),
    // os.totalmem() is HOST physical memory, not the Pterodactyl allocation.
    hostMemoryGiB: Math.round(totalmem() / ONE_GIB * 10) / 10,
    cgroup: await linuxLimits(),
    workspaceWritable: false,
    copiedNativeExecutable: 'not-tested',
    // These cannot be established safely by a Node script.
    persistentAfterRestart: 'not-tested',
    customDockerImageAllowed: 'not-tested',
    inferenceModelLoaded: false,
  };

  let folder;
  try {
    folder = await mkdtemp(join(process.cwd(), '.enthusia-bloom-probe-'));
    const hello = join(folder, 'test-write.txt');
    await writeFile(hello, 'enthusia-test-only', { mode: 0o600 });
    report.workspaceWritable = (await readFile(hello, 'utf8')) === 'enthusia-test-only';
    if (platform() === 'linux') {
      const source = ['/bin/true', '/usr/bin/true'].find((file) => existsSync(file));
      if (!source) {
        report.copiedNativeExecutable = 'binary-missing';
      } else {
        const dest = join(folder, 'test-execute');
        await copyFile(source, dest);
        await chmod(dest, 0o700);
        if (!(await stat(dest)).isFile()) throw new Error('Unexpected probe file type');
        report.copiedNativeExecutable = safeSpawn(dest) ? 'allowed' : 'blocked';
      }
    }
  } catch {
    report.workspaceWritable = false;
    report.copiedNativeExecutable = 'unknown';
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProbe().then((report) => {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }).catch(() => {
    process.stderr.write('Bloom capability check could not finish safely.\n');
    process.exitCode = 1;
  });
}
