/**
 * Stale-truth scenario template — the MANDATORY stale test.
 *
 * Spec: MASTER-SPECIFICATION.md §29.3, TRAINING-AND-EVALUATION-SPEC.md §21,
 * WORKER-EXECUTION-PLAN.md §23:
 *
 *   An A -> B source update must result in:
 *   - current answer B;
 *   - history A;
 *   - no normal retrieval of A as current.
 *
 * Two forms are provided:
 *
 * 1. `runStaleTruthScenario` — drives the 10 spec steps against a
 *    StaleMemoryProbe (memory-like interface W07 implements) plus model
 *    answer callbacks. Used for regression tests of the memory/indexing
 *    pipeline.
 * 2. `buildStaleTruthCases` — generates golden EvalCases from a template so
 *    the same A -> B invariant can be checked against any SystemUnderTest
 *    through the normal evaluator harness.
 */
import type { EvalCase } from '../types.js';

/** Minimal memory/indexing surface the stale scenario needs. */
export interface StaleMemoryProbe {
  teach(fact: string, value: string): Promise<void>;
  updateTo(fact: string, value: string): Promise<void>;
  reindex(): Promise<void>;
  currentValue(fact: string): Promise<string | undefined>;
  historyValues(fact: string): Promise<string[]>;
  /** The normal retrieval path a user question would take. */
  retrieveAsCurrent(query: string): Promise<string | undefined>;
}

export interface StaleScenarioParams {
  factName: string;
  /** Old fact A. */
  oldValue: string;
  /** New fact B. */
  newValue: string;
  currentQuestion: string;
  historyQuestion: string;
  /** Model answer to the current question (reads through the probe). */
  answerCurrent: (probe: StaleMemoryProbe, question: string) => Promise<string>;
  /** Model answer to the historical question (reads through the probe). */
  answerHistorical: (probe: StaleMemoryProbe, question: string) => Promise<string>;
}

export interface StaleStepResult {
  /** Spec §29.3 step number (1–10). */
  step: number;
  name: string;
  passed: boolean;
  detail: string;
}

export interface StaleScenarioResult {
  factName: string;
  passed: boolean;
  steps: StaleStepResult[];
}

function step(
  n: number,
  name: string,
  passed: boolean,
  detail: string,
): StaleStepResult {
  return { step: n, name, passed, detail };
}

const HISTORICAL_FRAMING = /previously|used to|historical|historically|before|was/i;

/**
 * Execute the 10 spec §29.3 steps against the probe + model callbacks.
 * Steps 1–6 check the memory/indexing pipeline; steps 7–10 check model
 * answers. Every step result is reported — a failure names its step.
 */
export async function runStaleTruthScenario(
  probe: StaleMemoryProbe,
  params: StaleScenarioParams,
): Promise<StaleScenarioResult> {
  const { factName, oldValue, newValue, currentQuestion, historyQuestion } = params;
  const steps: StaleStepResult[] = [];

  // 1. teach/index fact A
  await probe.teach(factName, oldValue);
  const afterTeach = await probe.currentValue(factName);
  steps.push(
    step(
      1,
      'teach/index fact A',
      afterTeach === oldValue,
      `current=${JSON.stringify(afterTeach)} expected=${JSON.stringify(oldValue)}`,
    ),
  );

  // 2. verify model answers A
  const answerA = await params.answerCurrent(probe, currentQuestion);
  steps.push(
    step(
      2,
      'verify model answers A',
      answerA.includes(oldValue),
      `answer=${JSON.stringify(answerA.slice(0, 120))}`,
    ),
  );

  // 3. update authoritative source to B
  await probe.updateTo(factName, newValue);
  steps.push(step(3, 'update authoritative source to B', true, `updated ${factName}`));

  // 4. re-index
  await probe.reindex();
  steps.push(step(4, 're-index', true, 'reindex completed'));

  // 5. ensure active memory is B
  const current = await probe.currentValue(factName);
  steps.push(
    step(
      5,
      'active memory is B',
      current === newValue,
      `current=${JSON.stringify(current)} expected=${JSON.stringify(newValue)}`,
    ),
  );

  // 6. ensure A exists only in history
  const history = await probe.historyValues(factName);
  const retrieved = await probe.retrieveAsCurrent(currentQuestion);
  const historyOk = history.includes(oldValue);
  const noLeak = retrieved !== oldValue;
  steps.push(
    step(
      6,
      'A exists only in history; no normal retrieval of A as current',
      historyOk && noLeak,
      `history=${JSON.stringify(history)} retrieveAsCurrent=${JSON.stringify(retrieved)}`,
    ),
  );

  // 7+8. ask current question; model must answer B
  const answerB = await params.answerCurrent(probe, currentQuestion);
  steps.push(step(7, 'ask current question', true, `answer=${JSON.stringify(answerB.slice(0, 120))}`));
  const answersB = answerB.includes(newValue);
  const notStaleAsCurrent =
    !answerB.includes(oldValue) ||
    HISTORICAL_FRAMING.test(answerB);
  steps.push(
    step(
      8,
      'current answer is B (A not presented as current)',
      answersB && notStaleAsCurrent,
      `answer=${JSON.stringify(answerB.slice(0, 160))}`,
    ),
  );

  // 9+10. ask historical question; model may answer A with historical framing
  const answerHist = await params.answerHistorical(probe, historyQuestion);
  steps.push(step(9, 'ask historical question', true, `answer=${JSON.stringify(answerHist.slice(0, 120))}`));
  const histOk =
    answerHist.includes(oldValue) && HISTORICAL_FRAMING.test(answerHist);
  steps.push(
    step(
      10,
      'historical answer may be A with historical framing',
      histOk,
      `answer=${JSON.stringify(answerHist.slice(0, 160))}`,
    ),
  );

  return {
    factName,
    passed: steps.every((s) => s.passed),
    steps,
  };
}

// ---------------------------------------------------------------------------
// In-memory probe (for tests and local scenario runs; W07 provides the real one)
// ---------------------------------------------------------------------------

/** Minimal in-memory StaleMemoryProbe for tests and local runs. */
export class InMemoryStaleProbe implements StaleMemoryProbe {
  private current = new Map<string, string>();
  private history = new Map<string, string[]>();

  async teach(fact: string, value: string): Promise<void> {
    this.current.set(fact, value);
  }

  async updateTo(fact: string, value: string): Promise<void> {
    const prev = this.current.get(fact);
    if (prev !== undefined && prev !== value) {
      const h = this.history.get(fact) ?? [];
      if (!h.includes(prev)) h.push(prev);
      this.history.set(fact, h);
    }
    this.current.set(fact, value);
  }

  async reindex(): Promise<void> {
    // In-memory: nothing to rebuild. Real probe re-reads the source of truth.
  }

  async currentValue(fact: string): Promise<string | undefined> {
    return this.current.get(fact);
  }

  async historyValues(fact: string): Promise<string[]> {
    return [...(this.history.get(fact) ?? [])];
  }

  async retrieveAsCurrent(query: string): Promise<string | undefined> {
    // Normal retrieval path: only current facts are visible.
    for (const [fact, value] of this.current) {
      if (query.toLowerCase().includes(fact.toLowerCase())) return value;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Golden-case template: the same invariant as EvalCases for the harness
// ---------------------------------------------------------------------------

export interface StaleCaseTemplate {
  factName: string;
  oldValue: string;
  newValue: string;
  currentQuestion: string;
  historyQuestion: string;
}

/**
 * Build golden EvalCases from the stale-truth template. The cases wire
 * through ctx.sources the way a re-indexed system would see them:
 * current = B, history = [A]. Expected outcomes (plan §23):
 * current answer B, history A, no normal retrieval of A as current.
 */
export function buildStaleTruthCases(t: StaleCaseTemplate): EvalCase[] {
  const slug = t.factName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const sources = {
    [t.factName]: t.newValue,
    [`${t.factName}:history`]: [t.oldValue],
  };
  return [
    {
      id: `stale-truth-${slug}-current`,
      category: 'stale-facts',
      title: `A->B update: current question about ${t.factName} answers B`,
      question: t.currentQuestion,
      context: { sources: { ...sources } },
      assertions: [
        { type: 'contains', value: t.newValue },
        {
          type: 'notContains',
          value: t.oldValue,
          message: 'old fact A must not be presented as current',
        },
        { type: 'toolCalled', tool: 'knowledge.search' },
      ],
      tags: ['stale', 'template'],
    },
    {
      id: `stale-truth-${slug}-history`,
      category: 'stale-facts',
      title: `A->B update: historical question about ${t.factName} may answer A with framing`,
      question: t.historyQuestion,
      context: { sources: { ...sources } },
      assertions: [
        { type: 'contains', value: t.oldValue },
        {
          type: 'matches',
          pattern: 'previously|used to|historical|historically|before|was',
          message: 'historical answer needs explicit historical framing',
        },
      ],
      tags: ['stale', 'template'],
    },
    {
      id: `stale-truth-${slug}-no-current-leak`,
      category: 'stale-facts',
      title: `A->B update: no normal retrieval of A as current for ${t.factName}`,
      question: `The source for ${t.factName} was updated. What is the current value of ${t.factName}?`,
      context: { sources: { ...sources } },
      assertions: [
        { type: 'contains', value: t.newValue },
        {
          type: 'notContains',
          value: t.oldValue,
          message: 'normal retrieval must not surface A as current',
        },
      ],
      tags: ['stale', 'template'],
    },
  ];
}
