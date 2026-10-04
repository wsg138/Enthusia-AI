/**
 * Unit tests: mock systems exhibit their documented failure modes.
 *
 * These tests pin the mocks' behavior so evaluator development has a stable
 * baseline. They also demonstrate what each failure mode looks like in a
 * report: stale answers, visibility leaks, under/over-escalation.
 */
import { describe, expect, it } from 'vitest';
import {
  runCases,
  buildVisibilityCases,
  buildEscalationCases,
  SEED_VISIBILITY_FIXTURES,
  SEED_ESCALATION_FIXTURES,
  SEED_GOLDEN_CASES,
  idealSystem,
  staleSystem,
  leakingSystem,
  silentSystem,
  overEscalatingSystem,
  naiveSystem,
} from '../src/index.js';

describe('defective mocks fail the right cases', () => {
  it('staleSystem fails the stale-facts seed cases', async () => {
    const stale = SEED_GOLDEN_CASES.filter((c) => c.category === 'stale-facts');
    const results = await runCases(staleSystem, stale);
    expect(results.every((r) => !r.passed)).toBe(true);
    // The stale answers specifically repeat the old facts as current.
    const details = results.flatMap((r) =>
      r.assertions.filter((a) => !a.passed).map((a) => a.detail),
    );
    expect(details.some((d) => d.includes('10s') || d.includes('1.21.10'))).toBe(true);
  });

  it('leakingSystem fails the privacy seed cases', async () => {
    const privacy = SEED_GOLDEN_CASES.filter((c) => c.category === 'privacy');
    const results = await runCases(leakingSystem, privacy);
    expect(results.every((r) => !r.passed)).toBe(true);
  });

  it('silentSystem fails escalation cases that require staff', async () => {
    const esc = SEED_GOLDEN_CASES.filter((c) => c.category === 'escalation');
    const results = await runCases(silentSystem, esc);
    expect(results.every((r) => !r.passed)).toBe(true);
  });

  it('overEscalatingSystem fails no-escalation cases', async () => {
    const noEsc = SEED_GOLDEN_CASES.filter((c) => c.id === 'ambiguous-questions-001');
    const results = await runCases(overEscalatingSystem, noEsc);
    expect(results[0]?.passed).toBe(false);
  });

  it('naiveSystem fails tool-selection assertions', async () => {
    const tools = SEED_GOLDEN_CASES.filter((c) => c.id === 'commands-001');
    const results = await runCases(naiveSystem, tools);
    expect(results[0]?.passed).toBe(false);
  });
});

describe('scenario builders', () => {
  it('visibility fixtures pass on idealSystem and fail on leakingSystem', async () => {
    const cases = buildVisibilityCases(SEED_VISIBILITY_FIXTURES);
    expect(cases).toHaveLength(4);
    expect(cases.every((c) => c.category === 'privacy')).toBe(true);

    const good = await runCases(idealSystem, cases);
    const goodFailed = good.filter((r) => !r.passed);
    expect(goodFailed.map((r) => r.caseId)).toEqual([]);

    // leakingSystem leaks on the two fixtures it has rules for.
    const bad = await runCases(leakingSystem, cases);
    expect(bad.filter((r) => !r.passed).length).toBeGreaterThanOrEqual(2);
  });

  it('escalation fixtures pass on idealSystem', async () => {
    const cases = buildEscalationCases(SEED_ESCALATION_FIXTURES);
    const results = await runCases(idealSystem, cases);
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });
});
