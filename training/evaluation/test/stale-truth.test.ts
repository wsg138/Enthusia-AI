/**
 * Unit tests: the mandatory stale-truth scenario (spec §29.3).
 *
 * Covers both forms:
 * 1. runStaleTruthScenario against an in-memory probe (the 10 spec steps).
 * 2. buildStaleTruthCases as golden EvalCases run through the harness.
 */
import { describe, expect, it } from 'vitest';
import {
  runStaleTruthScenario,
  buildStaleTruthCases,
  InMemoryStaleProbe,
  runCases,
  makeSourceReadingSystem,
  makeStaleAnsweringSystem,
  idealSystem,
  SEED_GOLDEN_CASES,
  type StaleMemoryProbe,
} from '../src/index.js';

const TEMPLATE = {
  factName: 'server motd',
  oldValue: 'Welcome!',
  newValue: 'Welcome to Enthusia!',
  currentQuestion: 'What is the current value of server motd?',
  historyQuestion: 'What was server motd historically, before the update?',
};

const answerCurrent = async (probe: StaleMemoryProbe): Promise<string> => {
  const v = await probe.currentValue(TEMPLATE.factName);
  return `Current: ${v}`;
};
const answerHistorical = async (probe: StaleMemoryProbe): Promise<string> => {
  const h = await probe.historyValues(TEMPLATE.factName);
  return `Historical record: previously "${h[h.length - 1] ?? '?'}"`;
};

describe('runStaleTruthScenario', () => {
  it('passes all 10 spec steps for a correct pipeline + model', async () => {
    const result = await runStaleTruthScenario(new InMemoryStaleProbe(), {
      ...TEMPLATE,
      answerCurrent,
      answerHistorical,
    });
    expect(result.steps).toHaveLength(10);
    expect(result.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(
      result.steps.filter((s) => !s.passed).map((s) => `${s.step}: ${s.detail}`),
    ).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails step 8 when the model keeps answering the stale fact A', async () => {
    const staleAnswer = async (): Promise<string> => `The answer is ${TEMPLATE.oldValue}.`;
    const result = await runStaleTruthScenario(new InMemoryStaleProbe(), {
      ...TEMPLATE,
      answerCurrent: staleAnswer,
      answerHistorical,
    });
    expect(result.passed).toBe(false);
    const failed = result.steps.filter((s) => !s.passed).map((s) => s.step);
    expect(failed).toContain(8);
  });

  it('fails step 6 when retrieval still surfaces A as current', async () => {
    const leaky = new InMemoryStaleProbe();
    // Break the probe: retrieval returns history as if it were current.
    leaky.retrieveAsCurrent = async () => TEMPLATE.oldValue;
    const result = await runStaleTruthScenario(leaky, {
      ...TEMPLATE,
      answerCurrent,
      answerHistorical,
    });
    expect(result.passed).toBe(false);
    expect(result.steps.find((s) => s.step === 6)?.passed).toBe(false);
  });
});

describe('buildStaleTruthCases', () => {
  it('builds current/history/no-leak cases keyed by fact', () => {
    const cases = buildStaleTruthCases(TEMPLATE);
    expect(cases.map((c) => c.id)).toEqual([
      'stale-truth-server-motd-current',
      'stale-truth-server-motd-history',
      'stale-truth-server-motd-no-current-leak',
    ]);
    expect(cases.every((c) => c.category === 'stale-facts')).toBe(true);
  });

  it('a source-reading system passes the template; a stale system fails it', async () => {
    const cases = buildStaleTruthCases(TEMPLATE);
    const good = await runCases(makeSourceReadingSystem(), cases);
    expect(good.filter((r) => !r.passed)).toEqual([]);

    const bad = await runCases(makeStaleAnsweringSystem(TEMPLATE.oldValue), cases);
    expect(bad.every((r) => !r.passed)).toBe(true);
  });

  it('seed stale cases pass against idealSystem', async () => {
    const stale = SEED_GOLDEN_CASES.filter((c) => c.category === 'stale-facts');
    expect(stale.length).toBeGreaterThan(0);
    const results = await runCases(idealSystem, stale);
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });
});
