/**
 * Checked model-runtime plan for the single-server Bloom STAGING supervisor.
 *
 * This module never starts a process. It validates an explicitly supplied
 * llama-server binary and model against operator-pinned SHA-256 digests before
 * a child can be spawned. Real model artifacts are NOT in the Git repository.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_MODEL_SIZE = 32 * 1024 ** 3;
const MAX_BINARY_SIZE = 1024 ** 3;

function boundedInteger(value, label, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(label + ' must be an integer from ' + min + ' to ' + max);
  }
  return n;
}

function checkedPath(path, sha, label) {
  if (typeof path !== 'string' || !isAbsolute(path) ||
      typeof sha !== 'string' || !SHA256.test(sha)) {
    throw new Error(label + ' requires an absolute file path and pinned SHA-256');
  }
  return { path, sha: sha.toLowerCase() };
}

async function hashPinnedFile(descriptor, maximum, label) {
  let before;
  try {
    before = await stat(descriptor.path);
  } catch {
    throw new Error(label + ' is missing or not accessible');
  }
  if (!before.isFile() || before.size < 1 || before.size > maximum) {
    throw new Error(label + ' is not an allowed regular file size');
  }
  const hash = createHash('sha256');
  try {
    for await (const block of createReadStream(descriptor.path)) hash.update(block);
  } catch {
    throw new Error(label + ' could not be read');
  }
  const after = await stat(descriptor.path);
  if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino) {
    throw new Error(label + ' changed during verification');
  }
  if (hash.digest('hex') !== descriptor.sha) {
    throw new Error(label + ' SHA-256 does not match the approved artifact');
  }
}

/**
 * Real model runtime args come only from a bounded, explicit allowlist.
 * No arbitrary extra CLI flags, remote model URLs, unbounded parallelism,
 * model download, or shell interpreter path can be supplied by a question.
 */
export async function prepareManagedInference(env, inferencePort) {
  const model = checkedPath(env.ENTHUSIA_MODEL_PATH, env.ENTHUSIA_MODEL_SHA256, 'Model artifact');
  const binary = checkedPath(env.ENTHUSIA_LLAMA_SERVER_PATH,
    env.ENTHUSIA_LLAMA_SERVER_SHA256, 'Inference executable');
  const threads = boundedInteger(env.ENTHUSIA_INFERENCE_THREADS, 'Inference thread count', 4, 1, 8);
  const context = boundedInteger(env.ENTHUSIA_INFERENCE_CONTEXT, 'Inference context', 8192, 1024, 8192);
  const modelName = env.ENTHUSIA_INFERENCE_MODEL ?? 'enthusia-qwen3';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(modelName)) {
    throw new Error('Inference model alias contains invalid characters');
  }
  if (!Number.isInteger(inferencePort) || inferencePort < 1024 || inferencePort > 65535) {
    throw new Error('Invalid managed inference port');
  }
  await hashPinnedFile(model, MAX_MODEL_SIZE, 'Model artifact');
  await hashPinnedFile(binary, MAX_BINARY_SIZE, 'Inference executable');
  return {
    executable: binary.path,
    args: [
      '--model', model.path,
      '--alias', modelName,
      '--host', '127.0.0.1',
      '--port', String(inferencePort),
      '--threads', String(threads),
      '--ctx-size', String(context),
      '--parallel', '1',
      '--reasoning', 'off',
      '--no-webui',
      '--no-slots',
      '--metrics',
    ],
    port: inferencePort,
    modelName,
    threads,
  };
}
