/**
 * Checked model-runtime plan for the single-server Bloom STAGING supervisor.
 *
 * This module never starts a process. It validates an explicitly supplied
 * llama-server binary and model against operator-pinned SHA-256 digests before
 * a child can be spawned. Real model artifacts are NOT in the Git repository.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
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

async function hashPinnedFile(descriptor, maximum, label, keepOpen = false) {
  // A path-level stat followed by a separate createReadStream can hash a
  // different inode if a model or executable is replaced between operations.
  // Reject direct symlinks and hash the SAME open file handle whose metadata
  // is checked before/after reading. Linux O_NOFOLLOW also closes the narrow
  // lstat-to-open symlink replacement window.
  let pathBefore;
  try {
    pathBefore = await lstat(descriptor.path);
  } catch {
    throw new Error(label + ' is missing or not accessible');
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() ||
      pathBefore.size < 1 || pathBefore.size > maximum) {
    throw new Error(label + ' is not an allowed regular non-symlink file size');
  }

  let handle;
  try {
    handle = await open(descriptor.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error(label + ' is missing, linked or not accessible');
  }

  let validated = false;
  try {
    const opened = await handle.stat();
    const sameObject = (a, b) => a.isFile() && !a.isSymbolicLink() &&
      a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
      a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    if (!sameObject(opened, pathBefore)) {
      throw new Error(label + ' changed during verification');
    }
    const digest = createHash('sha256');
    // Keep the file descriptor open while hashing; never reopen by pathname.
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        digest.update(chunk);
      }
    } catch {
      throw new Error(label + ' could not be read');
    }
    let afterRead;
    let pathAfter;
    try {
      afterRead = await handle.stat();
      pathAfter = await lstat(descriptor.path);
    } catch {
      throw new Error(label + ' changed during verification');
    }
    if (!sameObject(afterRead, opened) || !sameObject(pathAfter, opened)) {
      throw new Error(label + ' changed during verification');
    }
    if (digest.digest('hex') !== descriptor.sha) {
      throw new Error(label + ' SHA-256 does not match the approved artifact');
    }
    validated = true;
    return keepOpen ? handle : undefined;
  } finally {
    if (!keepOpen || !validated) await handle.close();
  }
}
/**
 * Real model runtime args come only from a bounded, explicit allowlist.
 * No arbitrary extra CLI flags, remote model URLs, unbounded parallelism,
 * model download, or shell interpreter path can be supplied by a question.
 */
export async function prepareManagedInference(env, inferencePort, options = {}) {
  const fdLaunch = options.verifiedFdLaunch === true;
  if (fdLaunch && process.platform !== 'linux') {
    throw new Error('Verified descriptor launch requires Linux procfs');
  }
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
  // The real Linux launcher retains the *verified* open inodes and gives
  // them fixed child FDs 3 (executable) and 4 (GGUF), not mutable pathnames.
  // This avoids copying ~19 GB and prevents a post-check rename/symlink swap
  // from redirecting execve() or llama.cpp's model open().
  const modelHandle = await hashPinnedFile(model, MAX_MODEL_SIZE, 'Model artifact', fdLaunch);
  let binaryHandle;
  try {
    binaryHandle = await hashPinnedFile(binary, MAX_BINARY_SIZE, 'Inference executable', fdLaunch);
  } catch (error) {
    await modelHandle?.close();
    throw error;
  }
  let released = false;
  const closePinnedFiles = async () => {
    if (released) return;
    released = true;
    await Promise.all([binaryHandle?.close(), modelHandle?.close()]);
  };
  return {
    executable: fdLaunch ? '/proc/self/fd/3' : binary.path,
    ...(fdLaunch ? {
      descriptorFds: [binaryHandle.fd, modelHandle.fd],
      closePinnedFiles,
    } : {}),
    args: [
      '--model', fdLaunch ? '/proc/self/fd/4' : model.path,
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
