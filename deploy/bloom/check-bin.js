/**
 * Owner-only, one-shot Bloom node.js generic native llama.cpp test.
 *
 * Upload into an otherwise empty approved 5 GB test server:
 *  check-bin.js, llama-server, llama-server.sha256
 * Set MAIN FILE=check-bin.js and start ONCE.
 *
 * No network, model weights, Discord, API keys, SFTP, external commands or
 * package installation. Invokes ONLY this verified binary with '--help'.
 * Normal successful exit code is 0; the egg may mark an exited test offline.
 */
const { createHash, timingSafeEqual } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { readFile, stat, chmod } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const root = process.cwd();
const executable = join(root, 'llama-server');
const manifest = join(root, 'llama-server.sha256');
const MAX_BYTES = 300 * 1024 * 1024;

async function check() {
  let bytes = 0;
  let passed = false;
  let reason = 'not-run';
  try {
    const m = (await readFile(manifest, 'utf8')).trim();
    const matched = /^([0-9a-fA-F]{64})\s+\*?llama-server$/.exec(m);
    if (!matched) throw new Error('invalid-hash-file');
    const info = await stat(executable);
    if (!info.isFile() || info.size < 1000 || info.size > MAX_BYTES) {
      throw new Error('invalid-file-size');
    }
    bytes = info.size;
    const checksum = createHash('sha256');
    for await (const part of createReadStream(executable)) checksum.update(part);
    const received = Buffer.from(checksum.digest('hex'), 'hex');
    const expected = Buffer.from(matched[1], 'hex');
    if (!timingSafeEqual(received, expected)) throw new Error('checksum-mismatch');
    await chmod(executable, 0o700);
    const result = spawnSync(executable, ['--help'], {
      cwd: root, env: {}, shell: false, stdio: 'ignore', timeout: 5000,
    });
    passed = result.status === 0 && !result.error;
    const code = result.error?.code;
    reason = passed ? 'binary-runs'
      : code === 'ETIMEDOUT' ? 'binary-timeout'
      : code === 'ENOENT' ? 'missing-binary-dependency'
      : code === 'EACCES' || code === 'EPERM' ? 'execution-permission-denied'
      : result.signal ? 'binary-killed-by-signal'
      : 'binary-exited-nonzero';
  } catch (error) {
    const allowed = ['invalid-hash-file', 'invalid-file-size', 'checksum-mismatch'];
    reason = allowed.includes(error?.message) ? error.message : 'missing-or-unreadable-file';
  }
  console.log(JSON.stringify({
    probe: 'enthusia-bloom-native-inference-v1',
    result: passed ? 'PASS' : 'FAIL',
    reason, binaryBytes: bytes,
    modelLoaded: false,
    networkUsed: false,
    discordConnected: false,
    sftpConnected: false,
  }, null, 2));
  if (!passed) process.exitCode = 1;
}

check().catch(() => {
  console.error('Bloom native executable test failed safely.');
  process.exitCode = 1;
});
