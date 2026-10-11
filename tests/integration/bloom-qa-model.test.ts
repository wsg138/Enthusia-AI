import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const qa = requireModule('../../deploy/bloom/bloom-qa.js') as {
  QUALITY_CASES: readonly { id: string; kind: string; question: string }[];
  MODEL_NAME: string;
  MODEL_SHA256: string;
};
const source = readFileSync('deploy/bloom/bloom-qa.js', 'utf8');

describe('Bloom model sustained answer-quality pilot', () => {
  it('pins the same already-tested SHA-256 model and runs 15 distinct questions', () => {
    expect(qa.MODEL_NAME).toBe('Qwen3-1.7B-Q4_K_M.gguf');
    expect(qa.MODEL_SHA256).toBe('d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5');
    expect(qa.QUALITY_CASES).toHaveLength(15);
    expect(new Set(qa.QUALITY_CASES.map((c) => c.id)).size).toBe(15);
    expect(new Set(qa.QUALITY_CASES.map((c) => c.question)).size).toBe(15);
    expect(qa.QUALITY_CASES.every((c) => ['fact', 'unknown', 'safety'].includes(c.kind))).toBe(true);
  });
  it('asks for honesty about unknown private and live info', () => {
    const unknown = qa.QUALITY_CASES.filter((c) => c.kind === 'unknown');
    expect(unknown.length).toBeGreaterThanOrEqual(3);
    expect(unknown.some((c) => /online/i.test(c.question))).toBe(true);
    expect(unknown.some((c) => /bann?ed/i.test(c.question))).toBe(true);
    expect(source).toContain('never invent policies, moderation records, credentials, or player counts');
    expect(source).toContain('answersRequireHumanReview: true');
  });
  it('runs one question at a time on a private localhost model with resource guard', () => {
    expect(source).toContain("'--host', '127.0.0.1'");
    expect(source).toContain("'--threads', '2'");
    expect(source).toContain("'--parallel', '1'");
    expect(source).toContain("stopAtFraction = 0.9");
    expect(source).toContain("max_tokens: 96, temperature: 0, stream: false");
    expect(source).toContain("child.kill('SIGTERM')");
    expect(source).toContain('bloom-qa-report.json');
    expect(source).toContain('[qwen-qa] RESULT');
    expect(source).not.toContain("'--host', '0.0.0.0'");
    expect(source).not.toMatch(/DISCORD_BOT_TOKEN|SFTP_PASSWORD|MYSQL_PASSWORD/);
  });
});
