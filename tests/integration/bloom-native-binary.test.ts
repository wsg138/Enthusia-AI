import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'enthusia-native-bloom-test-'));
  dirs.push(dir);
  await copyFile(resolve('deploy/bloom/check-bin.js'), join(dir, 'check-bin.js'));
  return dir;
}
function run(dir: string) {
  const x = spawnSync(process.execPath, ['check-bin.js'], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
    timeout: 7500,
  });
  return { code: x.status, stdout: x.stdout, stderr: x.stderr };
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('Bloom native model CLI check — no model, no network or tokens', () => {
  it('fails safely when the packaged runtime binary is missing', async () => {
    const dir = await sandbox();
    const result = run(dir);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report.reason).toBe('missing-or-unreadable-file');
    expect(report.modelLoaded).toBe(false);
    expect(report.networkUsed).toBe(false);
    expect(report.discordConnected).toBe(false);
    expect(report.sftpConnected).toBe(false);
  });

  it('refuses to execute a file with the wrong pinned SHA-256', async () => {
    const dir = await sandbox();
    await writeFile(join(dir, 'llama-server'), 'X'.repeat(1600));
    await writeFile(join(dir, 'llama-server.sha256'),
      '0'.repeat(64) + '  llama-server\n');
    const result = run(dir);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report.reason).toBe('checksum-mismatch');
    expect(report.result).toBe('FAIL');
    expect(result.stdout).not.toContain(process.env.DISCORD_BOT_TOKEN ?? 'no-real-discord-secret');
  });

  it('validates an exact package manifest then fails closed for invalid executable', async () => {
    const dir = await sandbox();
    const invalid = 'X'.repeat(1600);
    await writeFile(join(dir, 'llama-server'), invalid);
    const checksum = createHash('sha256').update(invalid).digest('hex');
    await writeFile(join(dir, 'llama-server.sha256'), checksum + '  llama-server\n');
    const result = run(dir);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report.reason).toBe('binary-exited-nonzero');
    expect(report.binaryBytes).toBe(1600);
    expect(report.modelLoaded).toBe(false);
  });
});
