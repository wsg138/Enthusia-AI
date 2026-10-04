/**
 * Unit tests: report generation.
 */
import { describe, expect, it } from 'vitest';
import type { CaseResult } from '../src/index.js';
import {
  evaluate,
  generateReport,
  reportToJson,
  renderMarkdownSummary,
  idealSystem,
  silentSystem,
  overEscalatingSystem,
  SEED_GOLDEN_CASES,
  GOLDEN_DATASET_NAME,
  GOLDEN_DATASET_VERSION,
  GOLDEN_DATASET_FROZEN,
} from '../src/index.js';

const DATASET = {
  name: GOLDEN_DATASET_NAME,
  version: GOLDEN_DATASET_VERSION,
  frozen: GOLDEN_DATASET_FROZEN,
};

function byId(ids: string[]) {
  const idx = new Map(SEED_GOLDEN_CASES.map((c) => [c.id, c]));
  return ids.map((id) => {
    const c = idx.get(id);
    if (!c) throw new Error(`unknown case ${id}`);
    return c;
  });
}

describe('generateReport', () => {
  it('produces per-category scores and a machine-readable JSON report', async () => {
    const cases = byId(['onboarding-001', 'commands-001', 'escalation-001', 'escalation-002']);
    const report = await evaluate(idealSystem, cases, { systemName: 'mock:ideal', dataset: DATASET });
    expect(report.summary.total).toBe(4);
    expect(report.summary.passed).toBe(4);
    expect(report.summary.score).toBe(1);
    expect(report.perCategory['onboarding'].score).toBe(1);
    expect(report.perCategory['escalation'].score).toBe(1);
    expect(report.perCategory['privacy'].total).toBe(0);
    expect(report.metrics.sourceCorrectness).toBe(1);
    expect(report.metrics.escalationPrecision).toBe(1);
    expect(report.metrics.escalationRecall).toBe(1);
    expect(report.metrics.timeoutRate).toBe(0);
    expect(report.metrics.unauthorizedDisclosureRate).toBe(0);

    // JSON round-trip: the report is machine-readable.
    const parsed = JSON.parse(reportToJson(report)) as typeof report;
    expect(parsed.reportId).toBe(report.reportId);
    expect(parsed.cases).toHaveLength(4);
  });

  it('escalation recall drops for a system that never escalates', async () => {
    const cases = byId(['escalation-001', 'escalation-002', 'onboarding-001']);
    const report = await evaluate(silentSystem, cases, { systemName: 'mock:silent', dataset: DATASET });
    expect(report.metrics.escalationRecall).toBe(0);
    expect(report.summary.passed).toBeLessThan(3);
  });

  it('escalation precision drops for a system that escalates everything', async () => {
    const cases = byId(['escalation-001', 'onboarding-001', 'commands-001']);
    const report = await evaluate(overEscalatingSystem, cases, {
      systemName: 'mock:over',
      dataset: DATASET,
    });
    // escalation-001 and onboarding-001 carry escalatedTo assertions; both
    // responses escalate but only escalation-001 has the right target.
    expect(report.metrics.escalationPrecision).toBeCloseTo(1 / 2);
    expect(report.metrics.escalationRecall).toBe(1);
  });

  it('handles empty runs without NaN', () => {
    const report = generateReport('mock:empty', DATASET, [] as CaseResult[], []);
    expect(report.summary.score).toBe(0);
    expect(report.metrics.escalationPrecision).toBeNull();
    expect(report.metrics.escalationRecall).toBeNull();
    expect(Number.isNaN(report.metrics.avgLatencyMs)).toBe(false);
  });

  it('renders a markdown summary with per-category rows', async () => {
    const report = await evaluate(idealSystem, byId(['privacy-001']), {
      systemName: 'mock:ideal',
      dataset: DATASET,
    });
    const md = renderMarkdownSummary(report);
    expect(md).toContain('# Evaluation report: mock:ideal');
    expect(md).toContain('| privacy | 1 | 1 | 100% |');
    expect(md).toContain('source correctness');
    expect(md).toContain('unauthorized-disclosure rate');
  });
});
