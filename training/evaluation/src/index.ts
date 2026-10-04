/**
 * @enthusia/training-evaluation — Model/system evaluation framework.
 *
 * Spec: MASTER-SPECIFICATION.md §29, TRAINING-AND-EVALUATION-SPEC.md §§11, 12, 20–24.
 *
 * Makes model/system quality measurable: a frozen golden dataset, an
 * evaluator harness that runs cases against a SystemUnderTest interface,
 * mock systems (no real model exists yet), scenario templates (stale-truth,
 * visibility, escalation), and machine-readable JSON regression reports.
 */
export type {
  EvalCategory,
  VisibilityClass,
  EscalationTarget,
  ToolCallTrace,
  EvalContext,
  EvalResponse,
  SystemUnderTest,
  Assertion,
  EvalCase,
  AssertionResult,
  CaseResult,
  RunOptions,
} from './types.js';
export { EVAL_CATEGORIES, visibilityRank, canDisclose } from './types.js';

export { runCases, runCasesDetailed, mergeContext, evaluateAssertion } from './harness/index.js';
export { evaluate } from './evaluate.js';
export type { EvaluateOptions } from './evaluate.js';

export {
  validateEvalCase,
  validateGoldenDataset,
  validateFrozenGoldenDataset,
  evalCaseSchema,
  SEED_GOLDEN_CASES,
  GOLDEN_DATASET_NAME,
  GOLDEN_DATASET_VERSION,
  GOLDEN_DATASET_FROZEN,
  goldenIndexById,
} from './golden/index.js';

export {
  runStaleTruthScenario,
  buildStaleTruthCases,
  InMemoryStaleProbe,
  buildVisibilityCases,
  SEED_VISIBILITY_FIXTURES,
  buildEscalationCases,
  SEED_ESCALATION_FIXTURES,
} from './scenarios/index.js';
export type {
  StaleMemoryProbe,
  StaleScenarioParams,
  StaleStepResult,
  StaleScenarioResult,
  StaleCaseTemplate,
  VisibilityFixture,
  EscalationFixture,
} from './scenarios/index.js';

export {
  generateReport,
  reportToJson,
  writeReport,
  renderMarkdownSummary,
} from './report/index.js';
export type {
  CategoryScore,
  EvalMetrics,
  CaseReportEntry,
  EvaluationReport,
} from './report/index.js';

export {
  idealSystem,
  staleSystem,
  leakingSystem,
  silentSystem,
  overEscalatingSystem,
  naiveSystem,
  makeStaleAnsweringSystem,
  makeSourceReadingSystem,
} from './mocks/systems.js';
