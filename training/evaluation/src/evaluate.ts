/**
 * Top-level evaluation entrypoint: run cases against a SUT and produce the
 * machine-readable report in one call.
 */
import type {
  EvalCase,
  RunOptions,
  SystemUnderTest,
} from './types.js';
import { validateFrozenGoldenDataset } from './golden/index.js';
import { runCasesDetailed } from './harness/index.js';
import {
  generateReport,
  type EvaluationReport,
} from './report/index.js';

export interface EvaluateOptions extends RunOptions {
  systemName: string;
  dataset?: { name: string; version: string; frozen: boolean };
}

export async function evaluate(
  sut: SystemUnderTest,
  cases: EvalCase[],
  options: EvaluateOptions,
): Promise<EvaluationReport> {
  if (options.dataset?.frozen === true) {
    validateFrozenGoldenDataset(cases);
  }
  const { results, responses } = await runCasesDetailed(sut, cases, options);
  return generateReport(
    options.systemName,
    options.dataset ?? { name: 'adhoc', version: 'v0', frozen: false },
    results,
    responses,
  );
}

export type { EvaluationReport };
