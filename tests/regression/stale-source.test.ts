/**
 * Regression: the mandatory stale-source test.
 *
 * Worker execution plan §23 / MASTER-SPECIFICATION.md §29.3:
 * an A -> B source update must result in current answer B, history A,
 * and no normal retrieval of A as current.
 *
 * Populated by W20 (evaluation) against an in-memory probe; W07 (memory)
 * will point the same scenario at the real memory service.
 */
import { describe, expect, it } from 'vitest';
import {
  runStaleTruthScenario,
  InMemoryStaleProbe,
} from '../../training/evaluation/src/index.js';

describe('stale-source regression (A -> B)', () => {
  it('yields current answer B, history A, no normal retrieval of A as current', async () => {
    const fact = 'server motd';
    const result = await runStaleTruthScenario(new InMemoryStaleProbe(), {
      factName: fact,
      oldValue: 'Welcome!',
      newValue: 'Welcome to Enthusia!',
      currentQuestion: 'What is the current value of server motd?',
      historyQuestion: 'What was server motd historically, before the update?',
      answerCurrent: async (probe) => `Current: ${await probe.currentValue(fact)}`,
      answerHistorical: async (probe) => {
        const history = await probe.historyValues(fact);
        return `Historical record: previously "${history[history.length - 1] ?? '?'}"`;
      },
    });
    expect(
      result.steps.filter((s) => !s.passed).map((s) => `step ${s.step} (${s.name}): ${s.detail}`),
    ).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
