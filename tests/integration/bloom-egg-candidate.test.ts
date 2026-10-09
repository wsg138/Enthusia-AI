import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface EggVariable {
  name: string;
  description: string;
  env_variable: string;
  default_value: string;
  user_editable: boolean;
  user_viewable: boolean;
  rules: string;
}
interface CandidateEgg {
  _comment: string;
  meta: { version: string; update_url: unknown };
  exported_at: string;
  name: string;
  description: string;
  docker_images: Record<string, string>;
  startup: string;
  features: string[];
  config: { files: string; startup: string; logs: string; stop: string };
  scripts: { installation: { script: string; container: string; entrypoint: string } };
  variables: EggVariable[];
}

const egg: CandidateEgg = JSON.parse(readFileSync(resolve(
  'deploy/bloom/egg-single-server-STAGING-CANDIDATE.json'), 'utf8')) as CandidateEgg;
const variables = new Map(egg.variables.map((v) => [v.env_variable, v]));

describe('Pterodactyl PTDL_v2 single-server review candidate (NOT deployed)', () => {
  it('is PTDL_v2-shaped with explicit disabled install gate', () => {
    expect(egg.meta.version).toBe('PTDL_v2');
    expect(egg.meta.update_url).toBeNull();
    expect(new Date(egg.exported_at).getTime()).not.toBeNaN();
    expect(egg._comment).toContain('NOT VALIDATED IN BLOOM');
    expect(egg.docker_images).toEqual({
      'UNBUILT - DO NOT SELECT': 'ghcr.io/enthusia/ai-single-server:UNPUBLISHED-DO-NOT-DEPLOY',
    });
    expect(egg.scripts.installation.script).toContain('exit 1');
    expect(egg.scripts.installation.script).not.toContain('curl ');
    expect(egg.scripts.installation.script).not.toContain('git clone');
  });

  it('launches only a single supervised tree and disables Discord by default', () => {
    expect(egg.startup).toBe(
      'node deploy/bloom/single-server-staging.mjs --managed-inference --managed-indexer --without-discord',
    );
    expect(egg.startup).not.toContain('{{');
    expect(egg.startup).not.toContain('--with-discord');
    expect(egg.startup).not.toContain('startup.sh');
    expect(JSON.parse(egg.config.startup)).toEqual({
      done: ['[bloom-staging] Agent and Gateway ready'],
    });
    expect(egg.config.stop).toBe('^C');
    expect(JSON.parse(egg.config.files)).toEqual({});
    expect(JSON.parse(egg.config.logs)).toEqual({});
  });

  it('requires pinned model assets and caps CPU inference threads', () => {
    expect(variables.get('ENTHUSIA_MODEL_SHA256')?.default_value).toBe('');
    expect(variables.get('ENTHUSIA_LLAMA_SERVER_SHA256')?.default_value).toBe('');
    expect(variables.get('ENTHUSIA_MODEL_PATH')?.default_value).toBe('/home/container/models/qwen3.gguf');
    expect(variables.get('ENTHUSIA_INFERENCE_THREADS')?.default_value).toBe('2');
    expect(variables.get('ENTHUSIA_INFERENCE_THREADS')?.rules).toContain('max:8');
    expect(variables.get('ENTHUSIA_INFERENCE_CONTEXT')?.default_value).toBe('4096');
    expect(variables.get('ENTHUSIA_INFERENCE_CONTEXT')?.rules).toContain('max:8192');
  });

  it('keeps the fixed public repo allowlist and persistent index storage', () => {
    expect(variables.get('ENTHUSIA_INDEXER_APPROVED_REPOS')?.default_value)
      .toBe('wsg138/MaceGuard,wsg138/PieCloak');
    expect(variables.get('ENTHUSIA_INDEXER_APPROVED_REPOS')?.user_editable).toBe(false);
    expect(variables.get('ENTHUSIA_INDEXER_DATA_DIR')?.default_value)
      .toBe('/home/container/data/knowledge');
    expect(variables.get('ENTHUSIA_INDEXER_PORT')?.default_value).toBe('4300');
  });

  it('hides source credential and never includes live SMP, SFTP or Discord credentials', () => {
    const token = variables.get('ENTHUSIA_INDEXER_GITHUB_TOKEN');
    expect(token?.default_value).toBe('');
    expect(token?.user_viewable).toBe(false);
    expect(token?.user_editable).toBe(false);
    const prohibited = [
      'DISCORD_BOT_TOKEN', 'SFTP_PASSWORD', 'SFTP_PRIVATE_KEY',
      'ENTHUSIA_AGENT_SFTP_CONFIG_PATH', 'DATABASE_URL', 'OPENAI_API_KEY',
    ];
    expect(prohibited.some((key) => variables.has(key))).toBe(false);
    expect(egg.startup).not.toMatch(/sftp|rcon|minecraft|tickets?/i);
  });

  it('has unique, conservatively limited variable names', () => {
    expect(variables.size).toBe(egg.variables.length);
    expect(egg.variables.length).toBeGreaterThan(5);
    for (const v of egg.variables) {
      expect(v.env_variable).toMatch(/^[A-Z][A-Z_0-9]+$/);
      expect(v.description.length).toBeGreaterThan(12);
      expect(v.rules).toMatch(/^required\|/);
      expect(v.default_value.length).toBeLessThan(270);
    }
  });
});
