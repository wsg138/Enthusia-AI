import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planSingleServer, makeStagingEnvironments } from '../../deploy/bloom/single-server-staging.mjs';

const launcher = resolve('deploy/bloom/single-server-staging.mjs');
const fakeEnv = {
  PATH: process.env.PATH ?? '',
  NODE_ENV: 'development',
  ENTHUSIA_BLOOM_STAGING: '1',
  ENTHUSIA_INFERENCE_BASE_URL: 'http://127.0.0.1:11434',
};

function run(overrides: Record<string, string> = {}, args = ['--dry-run']) {
  return spawnSync(process.execPath, [launcher, ...args], {
    encoding: 'utf8',
    timeout: 7000,
    env: { ...fakeEnv, ...overrides },
  });
}

describe('single Bloom staging launcher safety gates (dry-run, no network or tokens)', () => {
  it('rejects default invocation without explicit staging permission', () => {
    const result = run({ ENTHUSIA_BLOOM_STAGING: '0' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENTHUSIA_BLOOM_STAGING=1');
  });

  it('refuses production NODE_ENV even with staging flag', () => {
    const result = run({ NODE_ENV: 'production' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NODE_ENV=development');
  });

  it('rejects remote or non-loopback inference endpoints', () => {
    for (const endpoint of ['https://example.com/model', 'http://0.0.0.0:11434',
      'http://10.0.0.2:11434']) {
      const result = run({ ENTHUSIA_INFERENCE_BASE_URL: endpoint });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('local loopback');
    }
  });

  it('rejects inherited SFTP and private integration configuration', () => {
    for (const variable of [
      'ENTHUSIA_AGENT_SFTP_CONFIG_PATH',
      'ENTHUSIA_AGENT_TICKET_BOT_BASE_URL',
      'ENTHUSIA_AGENT_STAFF_MODERATION_BASE_URL',
      'ENTHUSIA_AGENT_AI_MODERATION_BASE_URL',
      'ENTHUSIA_AGENT_MEMORY_PATH',
    ]) {
      const result = run({ [variable]: 'not-an-actual-path-or-secret' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Private/live integrations');
      expect(result.stderr).not.toContain('not-an-actual-path-or-secret');
    }
  });

  it('rejects Discord staging without exact guild/channel restrictions', () => {
    const result = run({ DISCORD_BOT_TOKEN: 'fake-secret-that-must-not-be-logged' },
      ['--dry-run', '--with-discord']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exact test guild/channel');
    expect(result.stderr).not.toContain('fake-secret-that-must-not-be-logged');
  });

  it('refuses forbidden ticket-logs channel in an otherwise restricted Discord dry run', () => {
    const result = run({
      DISCORD_BOT_TOKEN: 'fake-test-token',
      ENTHUSIA_DISCORD_ALLOWED_GUILD_IDS: '1552729865306767471',
      ENTHUSIA_DISCORD_SLASH_GUILD_ID: '1552729865306767471',
      ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS: '1552873662745546822',
    }, ['--dry-run', '--with-discord']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exactly one test guild');
  });

  it('rejects duplicate local network ports', () => {
    const result = run({
      ENTHUSIA_AGENT_PORT: '4100',
      ENTHUSIA_AI_GATEWAY_PORT: '4100',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be distinct');
  });

  it('rejects inference port collisions with a trailing slash', () => {
    const result = run({
      ENTHUSIA_INFERENCE_BASE_URL: 'http://127.0.0.1:4100/',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ports must be distinct');
  });

  it.runIf(Number(process.versions.node.split('.')[0]) === 24)(
    'accepts only explicitly staged agent+gateway configuration without starting services', () => {
      const result = run();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Dry run validated');
      expect(result.stdout).toContain('no SFTP or SMP changes');
      expect(result.stdout).not.toContain('fake-secret');
    },
  );

  it('isolates GitHub credentials to the knowledge child only', () => {
    const sourceToken = 'synthetic-source-token-not-real';
    const env = {
      ...fakeEnv,
      ENTHUSIA_INDEXER_GITHUB_TOKEN: sourceToken,
      ENTHUSIA_INDEXER_APPROVED_REPOS: 'wsg138/MaceGuard,wsg138/PieCloak',
      ENTHUSIA_INDEXER_DATA_DIR: process.cwd(),
    };
    const plan = planSingleServer(['--managed-indexer', '--dry-run'], env);
    const children = makeStagingEnvironments(plan, env);
    expect(children.knowledge.ENTHUSIA_INDEXER_GITHUB_TOKEN).toBe(sourceToken);
    expect(children.knowledge.ENTHUSIA_INDEXER_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    for (const child of [children.agent, children.gateway, children.discord, children.inference]) {
      expect(child.ENTHUSIA_INDEXER_GITHUB_TOKEN).toBeUndefined();
      expect(child.ENTHUSIA_INDEXER_API_KEY).toBeUndefined();
    }
  });

  it('keeps the knowledge indexer disabled unless explicitly approved', () => {
    const result = run({}, ['--dry-run', '--managed-indexer']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Managed indexer needs exact public repo allowlist');
  });

  it('refuses managed indexing during the no-network smoke', () => {
    const result = run({}, ['--dry-run', '--smoke', '--managed-indexer']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot contact GitHub during an isolated smoke');
  });

  it('allows a restricted, credential-private indexer dry run without contacting GitHub', () => {
    const result = run({
      ENTHUSIA_INDEXER_APPROVED_REPOS: 'wsg138/MaceGuard,wsg138/PieCloak',
      ENTHUSIA_INDEXER_GITHUB_TOKEN: 'synthetic-token-must-not-be-logged',
      ENTHUSIA_INDEXER_DATA_DIR: process.cwd(),
    }, ['--dry-run', '--managed-indexer']);
    if (Number(process.versions.node.split('.')[0]) === 24) {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('public knowledge indexer');
      expect(result.stdout).not.toContain('synthetic-token-must-not-be-logged');
    }
  });

  it('rejects a knowledge port collision with the Agent or local model', () => {
    const r = run({
      ENTHUSIA_INDEXER_APPROVED_REPOS: 'wsg138/MaceGuard,wsg138/PieCloak',
      ENTHUSIA_INDEXER_GITHUB_TOKEN: 'synthetic',
      ENTHUSIA_INDEXER_DATA_DIR: process.cwd(),
      ENTHUSIA_INDEXER_PORT: '4200',
    }, ['--dry-run', '--managed-indexer']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('must be distinct');
  });

  it('refuses to bring Discord online in the credential-free smoke', () => {
    const result = run({
      DISCORD_BOT_TOKEN: 'fake-secret',
      ENTHUSIA_DISCORD_ALLOWED_GUILD_IDS: '1552729865306767471',
      ENTHUSIA_DISCORD_SLASH_GUILD_ID: '1552729865306767471',
      ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS: '1557855311224897607',
    }, ['--dry-run', '--smoke', '--with-discord']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must never connect to Discord');
    expect(result.stderr).not.toContain('fake-secret');
  });
});
