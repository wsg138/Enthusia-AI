import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareManagedInference } from '../../deploy/bloom/managed-inference.mjs';
import { makeStagingEnvironments, planSingleServer, runSingleServer } from '../../deploy/bloom/single-server-staging.mjs';

const folders: string[] = [];
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixtures() {
  const dir = await mkdtemp(join(tmpdir(), 'enthusia-bloom-model-test-'));
  folders.push(dir);
  const model = join(dir, 'synthetic.gguf');
  const binary = join(dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  await writeFile(model, 'synthetic model bytes, NOT a real GGUF');
  await writeFile(binary, 'synthetic binary bytes, NOT executable', { mode: 0o755 });
  return {
    ENTHUSIA_MODEL_PATH: model,
    ENTHUSIA_MODEL_SHA256: hashOf('synthetic model bytes, NOT a real GGUF'),
    ENTHUSIA_LLAMA_SERVER_PATH: binary,
    ENTHUSIA_LLAMA_SERVER_SHA256: hashOf('synthetic binary bytes, NOT executable'),
    ENTHUSIA_INFERENCE_MODEL: 'enthusia-qwen3',
  };
}

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { force: true, recursive: true });
});

describe('managed llama.cpp single Bloom model preflight (synthetic, never launch)', () => {
  it('verifies model and executable SHA-256 and enforces bounded safe CLI arguments', async () => {
    const env = await fixtures();
    const cfg = await prepareManagedInference(env, 15123);
    expect(cfg.executable).toBe(env.ENTHUSIA_LLAMA_SERVER_PATH);
    expect(cfg.args).toContain('--model');
    expect(cfg.args).toContain(env.ENTHUSIA_MODEL_PATH);
    expect(cfg.args).toContain('--no-webui');
    expect(cfg.args).toContain('--no-slots');
    expect(cfg.args).toContain('127.0.0.1');
    expect(cfg.args).toContain('15123');
    expect(cfg.args).toContain('--reasoning');
    expect(cfg.args).toContain('off');
    expect(cfg.args).toContain('--parallel');
    expect(cfg.args).toContain('1');
    expect(cfg.args).not.toContain('--api-key');
    expect(cfg.threads).toBe(4);
  });

  it('rejects mismatched pinned model and executable hashes', async () => {
    const env = await fixtures();
    await expect(prepareManagedInference({
      ...env, ENTHUSIA_MODEL_SHA256: '0'.repeat(64),
    }, 15123)).rejects.toThrow('Model artifact SHA-256');
    await expect(prepareManagedInference({
      ...env, ENTHUSIA_LLAMA_SERVER_SHA256: 'f'.repeat(64),
    }, 15123)).rejects.toThrow('Inference executable SHA-256');
  });

  it('rejects missing/relative paths and invalid digests without printing path values', async () => {
    const env = await fixtures();
    for (const bad of [
      { ENTHUSIA_MODEL_PATH: './fake-secret.gguf' },
      { ENTHUSIA_MODEL_SHA256: 'not-a-sha' },
      { ENTHUSIA_LLAMA_SERVER_PATH: 'llama-server' },
      { ENTHUSIA_LLAMA_SERVER_SHA256: '' },
    ]) {
      await expect(prepareManagedInference({ ...env, ...bad }, 15123))
        .rejects.toThrow('requires an absolute file path and pinned SHA-256');
    }
  });

  it('rejects unsafe/unbounded threads, context, alias and model-port settings', async () => {
    const env = await fixtures();
    for (const bad of [
      { ENTHUSIA_INFERENCE_THREADS: '64' },
      { ENTHUSIA_INFERENCE_THREADS: '0' },
      { ENTHUSIA_INFERENCE_CONTEXT: '65536' },
      { ENTHUSIA_INFERENCE_MODEL: '--remote-endpoint' },
      { ENTHUSIA_INFERENCE_MODEL: 'model with spaces' },
    ]) {
      await expect(prepareManagedInference({ ...env, ...bad }, 15123)).rejects.toThrow();
    }
    await expect(prepareManagedInference(env, 80)).rejects.toThrow('managed inference port');
  });

  it('leaves credentials only in supervised inference and Agent environments', async () => {
    const f = await fixtures();
    const plan = planSingleServer(['--dry-run', '--managed-inference'], {
      ...f, ENTHUSIA_BLOOM_STAGING: '1', NODE_ENV: 'development',
      ENTHUSIA_INFERENCE_BASE_URL: 'http://127.0.0.1:15123',
    });
    expect(plan.managedInference).toBe(true);
    const envs = makeStagingEnvironments(plan, {
      PATH: process.env.PATH ?? '',
      ENTHUSIA_INFERENCE_MODEL: 'enthusia-qwen3',
      // This must not leak into any child environment.
      SFTP_PASSWORD: 'synthetic-secret-should-never-appear',
    });
    expect(envs.inference.LLAMA_API_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(envs.agent.ENTHUSIA_INFERENCE_API_KEY).toBe(envs.inference.LLAMA_API_KEY);
    expect(envs.gateway.ENTHUSIA_INFERENCE_API_KEY).toBeUndefined();
    expect(envs.agent.ENTHUSIA_INFERENCE_THINKING_MODE).toBe('default');
    expect(envs.discord.ENTHUSIA_INFERENCE_API_KEY).toBeUndefined();
    expect(JSON.stringify(envs)).not.toContain('synthetic-secret-should-never-appear');
    expect(envs.discord.DISCORD_BOT_TOKEN).toBeUndefined();
  });

  it('requires pinned artifacts in dry-run, without starting a model', async () => {
    const f = await fixtures();
    const script = resolve('deploy/bloom/single-server-staging.mjs');
    const run = (override: Record<string, string>) => spawnSync(process.execPath,
      [script, '--dry-run', '--managed-inference'], {
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'development',
          ENTHUSIA_BLOOM_STAGING: '1',
          ...override,
        },
        encoding: 'utf8',
        timeout: 8000,
      });
    const refused = run({ ENTHUSIA_INFERENCE_BASE_URL: 'http://127.0.0.1:15123' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('pinned model');
    if (Number(process.versions.node.split('.')[0]) === 24) {
      const dryRun = run({
        ...f, ENTHUSIA_INFERENCE_BASE_URL: 'http://127.0.0.1:15123',
      });
      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain('pinned inference, agent, gateway');
    }
  });

  it('refuses actual model launch without explicit shared-host run approval', async () => {
    const f = await fixtures();
    const env = {
      ...f,
      NODE_ENV: 'development',
      ENTHUSIA_BLOOM_STAGING: '1',
      ENTHUSIA_INFERENCE_BASE_URL: 'http://127.0.0.1:15123',
    };
    const plan = planSingleServer(['--dry-run', '--managed-inference'], env);
    await expect(runSingleServer(plan, env)).rejects.toThrow(
      'explicit shared-host run approval',
    );
  });
  it.runIf(process.platform !== 'win32')(
    'rejects symlinked model/binary even when target checksums match', async () => {
      const env = await fixtures();
      const modelLink = env.ENTHUSIA_MODEL_PATH + '.link';
      const binaryLink = env.ENTHUSIA_LLAMA_SERVER_PATH + '.link';
      await symlink(env.ENTHUSIA_MODEL_PATH, modelLink);
      await symlink(env.ENTHUSIA_LLAMA_SERVER_PATH, binaryLink);
      await expect(prepareManagedInference({
        ...env, ENTHUSIA_MODEL_PATH: modelLink,
      }, 15123)).rejects.toThrow('non-symlink');
      await expect(prepareManagedInference({
        ...env, ENTHUSIA_LLAMA_SERVER_PATH: binaryLink,
      }, 15123)).rejects.toThrow('non-symlink');
    },
  );

  it('does not trust previously verified files after a replacement', async () => {
    const env = await fixtures();
    const first = await prepareManagedInference(env, 15123);
    expect(first.executable).toBe(env.ENTHUSIA_LLAMA_SERVER_PATH);
    const replacement = env.ENTHUSIA_LLAMA_SERVER_PATH + '.new';
    await writeFile(replacement, 'different executable bytes');
    await rm(env.ENTHUSIA_LLAMA_SERVER_PATH);
    await rename(replacement, env.ENTHUSIA_LLAMA_SERVER_PATH);
    await expect(prepareManagedInference(env, 15123))
      .rejects.toThrow('Inference executable SHA-256');
  });

});
