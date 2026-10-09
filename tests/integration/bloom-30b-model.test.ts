import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const baseline = requireModule('../../deploy/bloom/bloom-qa.js') as {
  QUALITY_CASES: Array<{ id: string; question: string }>;
};
const benchmark = requireModule('../../deploy/bloom/bloom-30b.js') as {
  MODEL_NAME: string;
  MODEL_URL: string;
  MODEL_SHA256: string;
  QUALITY_CASES: Array<{ id: string; question: string }>;
};
const source = readFileSync('deploy/bloom/bloom-30b.js', 'utf8');

describe('30B-A3B wiped spare Bloom staging gate', () => {
  it('uses the published 18.6 GB Q4_K_M checksum and a single immutable named GGUF', () => {
    expect(benchmark.MODEL_NAME).toBe('Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf');
    expect(benchmark.MODEL_SHA256).toBe('0155f4523b0c2e3cb541abdc4b5b1845e7b74af9ae8ae8dde9f4d09783371c86');
    expect(benchmark.MODEL_URL).toBe(
      'https://huggingface.co/second-state/Qwen3-30B-A3B-Instruct-2507-GGUF/resolve/main/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf?download=true',
    );
    expect(source).toContain('const MAX_MODEL_BYTES = 19_500_000_000;');
    expect(source).toContain('const MIN_MODEL_BYTES = 18_000_000_000;');
    expect(source).toContain('digest.digest(');
  });
  it('requires the owner wipe marker and rejects remaining Minecraft server files', () => {
    expect(source).toContain('enthusia-30b-staging-ok.txt');
    expect(source).toContain('CC19EA3C WIPED FOR ENTHUSIA AI');
    expect(source).toContain('refusing-to-run-on-uncleared-minecraft-server');
    expect(source).toContain('owner-wipe-confirmation-marker-missing');
    expect(source.indexOf('requireApprovedWipedServer();')).toBeLessThan(source.indexOf('await checkExecutable();'));
    expect(source.indexOf('await checkExecutable();')).toBeLessThan(source.indexOf('await downloadModel();'));
  });
  it('uses the exact same baseline questions and a bounded, no-Discord localhost-only resource test', () => {
    expect(benchmark.QUALITY_CASES.map(q => q.question)).toEqual(baseline.QUALITY_CASES.map(q => q.question));
    expect(benchmark.QUALITY_CASES).toHaveLength(15);
    expect(source).toContain("'--host', '127.0.0.1'");
    expect(source).toContain("'--threads', '4'");
    expect(source).toContain("'--parallel', '1'");
    expect(source).toContain("stopAtFraction = 0.80");
    expect(source).toContain('memoryLimit < 36_000_000_000 || memoryLimit > 65_000_000_000');
    expect(source).toContain('bloom-30b-report.json');
    expect(source).toContain("discord: false, minecraft: false, sftp: false, mysql: false");
    expect(source).not.toContain("'--host', '0.0.0.0'");
  });
});
