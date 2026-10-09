import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const bench = requireModule('../../deploy/bloom/bloom-1b.js') as {
  readNumber: (paths: string[]) => number | null;
  safeRegularFile: (path: string, maxBytes: number) => boolean;
  hashFile: (path: string, maxBytes: number) => Promise<string>;
  MODEL_SHA256: string;
  MODEL_URL: string;
  MODEL_NAME: string;
};
const script = readFileSync('deploy/bloom/bloom-1b.js', 'utf8');
const scratch: string[] = [];
async function tempDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'enthusia-bloom-1b-'));
  scratch.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('Bloom 1.7B GGUF performance gate', () => {
  it('pins the official ggml-org GGUF file revision and real SHA-256', () => {
    expect(bench.MODEL_NAME).toBe('Qwen3-1.7B-Q4_K_M.gguf');
    expect(bench.MODEL_SHA256).toBe(
      'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5',
    );
    expect(bench.MODEL_URL).toContain('huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/daeb8e2d528a760970442092f6bf1e55c3b659eb/');
    expect(script).toContain('digest.digest(');
    expect(script).toContain('MAX_MODEL_BYTES = 1_500_000_000');
  });

  it('refuses unexpected paths and verifies file contents with a real streaming hash', async () => {
    const dir = await tempDirectory();
    const realFile = join(dir, 'test-model.gguf');
    await writeFile(realFile, 'test-data');
    expect(bench.safeRegularFile(realFile, 100)).toBe(true);
    expect(bench.safeRegularFile(realFile, 3)).toBe(false);
    expect(await bench.hashFile(realFile, 100)).toBe(
      createHash('sha256').update('test-data').digest('hex'),
    );
    const linked = join(dir, 'linked.gguf');
    await symlink(realFile, linked, 'file');
    expect(bench.safeRegularFile(linked, 100)).toBe(false);
    await expect(bench.hashFile(linked, 100)).rejects.toThrow();
  });

  it('reads only bounded cgroup numeric values (not host memory)', async () => {
    const dir = await tempDirectory();
    const p = join(dir, 'cgroup.limit');
    await writeFile(p, '4999999488\n');
    expect(bench.readNumber([p])).toBe(4999999488);
    await writeFile(p, 'max\n');
    expect(bench.readNumber([p])).toBeNull();
    await writeFile(p, String(2 ** 62));
    expect(bench.readNumber([p])).toBeNull();
    await writeFile(p, '0');
    expect(bench.readNumber([p])).toBeNull();
  });

  it('restricts runtime to localhost, two CPU threads and one request', () => {
    expect(script).toContain("'--host', '127.0.0.1'");
    expect(script).toContain("'--threads', '2'");
    expect(script).toContain("'--ctx-size', '2048'");
    expect(script).toContain("'--parallel', '1'");
    expect(script).toContain("'--n-gpu-layers', '0'");
    expect(script).toContain('stopAtFraction = 0.9');
    expect(script).toContain("child.kill('SIGTERM')");
    expect(script).not.toContain("'--host', '0.0.0.0'");
    expect(script).not.toMatch(/DISCORD_BOT_TOKEN|SFTP_PASSWORD|MYSQL_PASSWORD|child_process.*execSync/);
  });

  it('stays a one-shot test and does not start production integrations', () => {
    expect(script).toContain('if (require.main === module)');
    expect(script).toContain("discord: false, minecraft: false, sftp: false, mysql: false");
    expect(script).toContain('bloom-1b-report.json');
    expect(script).not.toContain('setInterval(() => keepAlive');
  });
});
