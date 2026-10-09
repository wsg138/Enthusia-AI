import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve('.github/workflows/bloom-image-verify.yml'), 'utf8');
const dockerfile = readFileSync(
  resolve('deploy/bloom/Dockerfile.single-staging'), 'utf8');
const sourceCommit = '3d65c90d04d337e88f2b1f7f0061f40a5324e662';

/** Static-only guardrail; a workflow file existing is not a completed CI run. */
describe('Bloom Linux image CI review policy', () => {
  it('is restricted to pull requests or an exact isolated branch push', () => {
    expect(workflow).toMatch(/on:\s*\n\s+push:/);
    expect(workflow).toMatch(/branches:\r?\n\s+- 'fix\/discord-command-safe-upsert-20261008'/);
    expect(workflow).toMatch(/\bpull_request:\s*\n\s+paths:/);
    expect(workflow).toContain("github.ref == 'refs/heads/fix/discord-command-safe-upsert-20261008'");
    expect(workflow).not.toContain('workflow_dispatch');
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(workflow).toContain('timeout-minutes: 35');
    expect(workflow).toContain('cancel-in-progress: true');
  });

  it('uses a fixed 40-character upstream commit and never publishes any image', () => {
    expect(workflow).toContain('LLAMA_CPP_COMMIT=' + sourceCommit);
    expect(workflow).toContain('--file deploy/bloom/Dockerfile.single-staging');
    expect(dockerfile).toContain('git checkout --detach FETCH_HEAD');
    expect(workflow).not.toMatch(/docker\s+push|build-push-action|ghcr\.io\/enthusia\/ai-single-server/);
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('packages: write');
  });

  it('runs only no-network, no-privilege smoke checks, never a real Discord login', () => {
    expect(workflow).toContain('--network none --read-only --cap-drop ALL');
    expect(workflow).toContain('no-new-privileges');
    expect(workflow).toContain('--entrypoint /usr/local/bin/llama-server');
    expect(workflow).toContain('deploy/bloom/single-server-staging.mjs --dry-run --without-discord');
    expect(workflow).toContain('deploy/bloom/check-offline-supervisor.mjs');
    expect(workflow).toContain('--memory 768m --cpus 2 --pids-limit 128');
    expect(workflow).not.toContain('--with-discord');
    expect(workflow).not.toContain('docker run --privileged');
    expect(workflow).not.toMatch(/ENTHUSIA_AGENT_SFTP_CONFIG_PATH|DISCORD_BOT_TOKEN|SFTP_PASSWORD/);
  });
  it('retains only a SHA-256-protected diagnostic binary artifact, never a publishable image', () => {
    expect(workflow).toContain('docker cp "$cid":/usr/local/bin/llama-server');
    expect(workflow).toContain('sha256sum llama-server > llama-server.sha256');
    expect(workflow).toContain('cp deploy/bloom/check-bin.js bloom-native-check/check-bin.js');
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('retention-days: 5');
    expect(workflow).not.toContain('docker login');
    expect(workflow).not.toContain('gh release');
  });

});
