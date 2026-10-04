import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

/**
 * W21 deployment config validation.
 *
 * Parses every deploy YAML/JSON artifact and verifies required fields.
 * PREPARE ONLY: no network, no Pterodactyl API, no server access.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) throw new Error(`Invalid env line: ${line}`);
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

describe('deploy/bloom/egg.json', () => {
  it('is valid JSON with the required Pterodactyl egg fields', () => {
    const egg = JSON.parse(read('deploy/bloom/egg.json')) as Record<string, unknown>;
    expect(typeof egg['name']).toBe('string');
    expect(typeof egg['author']).toBe('string');
    expect(typeof egg['description']).toBe('string');
    // Pterodactyl eggs map display name -> image in a docker_images object.
    const images = egg['docker_images'] as Record<string, unknown>;
    expect(typeof images).toBe('object');
    expect(Object.keys(images).length).toBeGreaterThan(0);

    // Top-level `startup` is the container command; config.startup is the "done" matcher.
    expect(typeof egg['startup']).toBe('string');
    expect(egg['startup'] as string).toContain('startup.sh');
    const config = egg['config'] as Record<string, unknown>;
    expect(() => JSON.parse(config['startup'] as string)).not.toThrow();
    expect(typeof config['stop']).toBe('string');

    const variables = egg['variables'] as Array<Record<string, unknown>>;
    expect(Array.isArray(variables) && variables.length > 0).toBe(true);
    const envNames = new Set(variables.map((v) => v['env_variable']));
    for (const required of [
      'AI_SERVICE',
      'MODEL_RAM_MAX_GB',
      'INFERENCE_THREADS',
      'INDEXER_THREADS',
      'LOG_LEVEL',
      'METRICS_PORT',
      'HEALTH_PORT',
      'INFERENCE_BIND_HOST',
      'ENTHUSIA_INFERENCE_API_KEY',
    ]) {
      expect(envNames.has(required)).toBe(true);
    }
    for (const v of variables) {
      expect(typeof v['name']).toBe('string');
      expect(typeof v['env_variable']).toBe('string');
      expect(typeof v['default_value']).toBe('string');
      expect(typeof v['description']).toBe('string');
    }
    // Secrets must never be committed — no variable may ship a real secret default.
    for (const v of variables) {
      const envVar = String(v['env_variable']).toUpperCase();
      const def = String(v['default_value']);
      if (/(TOKEN|SECRET|PASSWORD|KEY)/.test(envVar)) {
        expect(def).toBe('');
      }
    }
  });
});

describe('deploy/bloom/startup.sh', () => {
  it('exists and references the documented entrypoints', () => {
    const path = join(repoRoot, 'deploy/bloom/startup.sh');
    expect(existsSync(path)).toBe(true);
    const script = read('deploy/bloom/startup.sh');
    expect(script).toContain('AI_SERVICE');
    expect(script).toContain('INFERENCE_THREADS');
    expect(script.length).toBeGreaterThan(200);
    expect(script).toContain('--metrics');
    expect(script).not.toContain('--metrics-port');
    expect(script).toContain('ENTHUSIA_INFERENCE_API_KEY');
    expect(script).toContain('LLAMA_API_KEY');
    expect(script).not.toContain('--api-key');
    expect(script).toContain('INFERENCE_BIND_HOST');
  });
});

describe('deploy/bloom/resource-limits.env', () => {
  it('parses and keeps the model within the §63 24-32 GB envelope', () => {
    const env = parseEnvFile(read('deploy/bloom/resource-limits.env'));
    const ramGb = Number(env['MODEL_RAM_MAX_GB']);
    expect(Number.isInteger(ramGb)).toBe(true);
    expect(ramGb).toBeGreaterThanOrEqual(24);
    expect(ramGb).toBeLessThanOrEqual(32);
    expect(Number(env['INFERENCE_THREADS'])).toBeGreaterThan(0);
    expect(Number(env['INDEXER_THREADS'])).toBeGreaterThan(0);
    expect(env['OOM_SCORE_ADJ']).toBeDefined();
    expect(env['LOG_LEVEL']).toBeDefined();
    expect(env['INFERENCE_BIND_HOST']).toBe('127.0.0.1');
  });
});

describe('deploy/local/docker-compose.yml', () => {
  it('is valid YAML with postgres and qdrant services', () => {
    const compose = yaml.load(read('deploy/local/docker-compose.yml')) as Record<string, unknown>;
    const services = compose['services'] as Record<string, Record<string, unknown>>;
    const postgres = services['postgres'];
    const qdrant = services['qdrant'];
    expect(postgres).toBeDefined();
    expect(qdrant).toBeDefined();
    expect(postgres?.['environment']).toBeDefined();
    // No production secrets baked into the compose file.
    const serialized = JSON.stringify(compose);
    expect(serialized).not.toMatch(/prod|secret|real-password/i);
  });
});

describe('deploy/local/systemd units', () => {
  for (const unit of ['enthusia-ai-agent.service', 'enthusia-ai-inference.service']) {
    it(`${unit} has unit/service/install sections and SMP-safety bounds`, () => {
      const text = read(`deploy/local/systemd/${unit}`);
      expect(text).toContain('[Unit]');
      expect(text).toContain('[Service]');
      expect(text).toContain('[Install]');
      expect(text).toMatch(/MemoryMax=\d+G/);
      expect(text).toMatch(/CPUQuota=\d+%/);
      expect(text).toContain('Restart=on-failure');
      // AI must die before SMP under memory pressure (§35.4).
      expect(text).toMatch(/OOMScoreAdjust=\d+/);
      expect(text).toContain('ExecStart=');
      if (unit === 'enthusia-ai-inference.service') {
        expect(text).toContain('--metrics');
        expect(text).not.toContain('--metrics-port');
        expect(text).toContain('/health');
        expect(text).not.toContain('/health/ready');
        expect(text).toContain('LLAMA_API_KEY');
        expect(text).not.toContain('--api-key');
        expect(text).toContain('INFERENCE_BIND_HOST=127.0.0.1');
        expect(text).toContain('TimeoutStopSec=120s');
      }
    });
  }
});

describe('deploy runbooks', () => {
  it('RUNBOOK.md covers startup, shutdown, rollback, and emergency procedures', () => {
    const doc = read('deploy/RUNBOOK.md');
    for (const section of ['Startup', 'Shutdown', 'Rollback', 'Emergency']) {
      expect(new RegExp(`^## .*${section}`, 'm').test(doc)).toBe(true);
    }
    expect(doc).toContain('/health/ready');
  });

  it('RESOURCE-LIMITS.md documents the §63 envelope and SMP safety rules', () => {
    const doc = read('deploy/RESOURCE-LIMITS.md');
    expect(doc).toContain('24');
    expect(doc).toContain('32');
    expect(doc.toLowerCase()).toContain('smp');
    expect(doc).toContain('OOM');
  });

  it('MODEL-ARTIFACTS.md covers the §64 manifest fields', () => {
    const doc = read('deploy/MODEL-ARTIFACTS.md');
    for (const field of ['adapter_hash', 'quantization', 'evaluation']) {
      expect(doc.toLowerCase()).toContain(field);
    }
  });

  it('LOGGING.md covers structured logging and secret redaction', () => {
    const doc = read('deploy/LOGGING.md');
    expect(doc.toLowerCase()).toContain('traceid');
    expect(doc.toLowerCase()).toContain('redact');
  });
});
