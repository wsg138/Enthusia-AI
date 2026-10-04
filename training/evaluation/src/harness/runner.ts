/**
 * Evaluator harness — runs EvalCases against a SystemUnderTest.
 *
 * Spec: MASTER-SPECIFICATION.md §29.2, TRAINING-AND-EVALUATION-SPEC.md §§11, 20.
 *
 * Sequential, deterministic execution. Each case gets a wall-clock timeout;
 * timed-out cases fail with timedOut=true and are counted in the timeout-rate
 * metric. Failures in the SUT (throw/reject) also fail the case and are
 * recorded — a crash is not a pass.
 */
import type {
  AssertionResult,
  CaseResult,
  EvalCase,
  EvalContext,
  EvalResponse,
  RunOptions,
  SystemUnderTest,
} from '../types.js';
import { evaluateAssertion } from './assertions.js';

const DEFAULT_TIMEOUT_MS = 30_000;

function defaultResponse(): EvalResponse {
  return {
    answer: '',
    sourcesUsed: [],
    toolCalls: [],
    escalated: 'none',
    disclosedVisibility: [],
  };
}

/** Merge per-case context overrides over the run defaults. */
export function mergeContext(
  defaults: Partial<EvalContext> | undefined,
  override: Partial<EvalContext> | undefined,
): EvalContext {
  const base: EvalContext = {
    requesterVisibility: 'PUBLIC',
    ...(defaults ?? {}),
  };
  const merged: EvalContext = { ...base, ...(override ?? {}) };
  // sources are merged shallowly so a case can add keys without replacing all.
  if (defaults?.sources !== undefined || override?.sources !== undefined) {
    merged.sources = { ...(defaults?.sources ?? {}), ...(override?.sources ?? {}) };
  }
  return merged;
}

interface CaseRun {
  result: CaseResult;
  response: EvalResponse;
}

async function runCase(
  sut: SystemUnderTest,
  testCase: EvalCase,
  opts: { timeoutMs: number; defaultContext?: Partial<EvalContext> },
): Promise<CaseRun> {
  const context = mergeContext(opts.defaultContext, testCase.context);
  const started = Date.now();
  let response: EvalResponse = defaultResponse();
  let timedOut = false;
  let error: string | undefined;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ kind: 'timeout' }),
        opts.timeoutMs,
      );
      timeoutHandle.unref?.();
    });
    const result = await Promise.race([
      sut(testCase.question, context).then(
        (r) => ({ kind: 'ok' as const, response: r }),
        (e: unknown) => ({ kind: 'threw' as const, error: e }),
      ),
      timeout,
    ]);
    if (result.kind === 'timeout') {
      timedOut = true;
      error = `case exceeded ${opts.timeoutMs}ms timeout`;
    } else if (result.kind === 'threw') {
      error =
        result.error instanceof Error
          ? `${result.error.name}: ${result.error.message}`
          : `system threw ${String(result.error)}`;
    } else {
      response = { ...defaultResponse(), ...result.response };
    }
  } catch (e: unknown) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }

  const latencyMs = Date.now() - started;
  const assertions: AssertionResult[] = timedOut
    ? testCase.assertions.map((a) => ({
        assertion: a,
        passed: false,
        detail: `case timed out after ${opts.timeoutMs}ms`,
      }))
    : testCase.assertions.map((a) => evaluateAssertion(a, response));

  const passed = !timedOut && error === undefined && assertions.every((a) => a.passed);

  const result: CaseResult = {
    caseId: testCase.id,
    category: testCase.category,
    title: testCase.title,
    passed,
    timedOut,
    latencyMs,
    assertions,
    ...(error !== undefined ? { error } : {}),
  };
  return { result, response };
}

/**
 * Run a set of cases against the system under test and return ordered
 * per-case results. Does NOT compute aggregate scores — use
 * generateReport() for the machine-readable report.
 */
export async function runCases(
  sut: SystemUnderTest,
  cases: EvalCase[],
  options: RunOptions = {},
): Promise<CaseResult[]> {
  const { results } = await runCasesDetailed(sut, cases, options);
  return results;
}

/**
 * Like runCases but also returns the raw SUT responses (parallel to results),
 * which generateReport needs for escalation/tokens/cost metrics.
 */
export async function runCasesDetailed(
  sut: SystemUnderTest,
  cases: EvalCase[],
  options: RunOptions = {},
): Promise<{ results: CaseResult[]; responses: EvalResponse[] }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: CaseResult[] = [];
  const responses: EvalResponse[] = [];
  for (const testCase of cases) {
    const { result, response } = await runCase(sut, testCase, {
      timeoutMs,
      ...(options.defaultContext !== undefined
        ? { defaultContext: options.defaultContext }
        : {}),
    });
    results.push(result);
    responses.push(response);
    options.onCase?.(result);
  }
  return { results, responses };
}
