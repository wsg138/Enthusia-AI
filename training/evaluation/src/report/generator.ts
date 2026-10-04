/**
 * Regression reporting — machine-readable JSON evaluation reports.
 *
 * Spec: MASTER-SPECIFICATION.md §29.2, TRAINING-AND-EVALUATION-SPEC.md §20.
 *
 * `generateReport` turns per-case results into a JSON-serializable report
 * with per-category scores and the spec §29.2 metrics the harness can
 * measure. Metrics the harness cannot measure per-case (RAM, CPU) are
 * intentionally absent — they belong to the performance harness, not the
 * behavioral evaluator; the report documents what each metric means.
 */
import { writeFile } from 'node:fs/promises';
import type { CaseResult, EvalCategory } from '../types.js';
import { EVAL_CATEGORIES } from '../types.js';

export interface CategoryScore {
  total: number;
  passed: number;
  failed: number;
  /** passed / total (0 when total is 0). */
  score: number;
  assertionsPassed: number;
  assertionsFailed: number;
}

export interface EvalMetrics {
  /** Case pass rate across the whole run. */
  overallScore: number;
  /** Pass rate over factual assertions (contains/matches/answerEquals/answered/not*). */
  factualCorrectness: number;
  /** Pass rate over explicit sourceUsed assertions. */
  sourceCorrectness: number;
  /** Share of stale-facts cases that failed (proxy for stale-answer rate). */
  staleAnswerRate: number;
  /** Share of cases failing >=1 factual assertion (proxy; see docs). */
  hallucinationRate: number;
  /** Pass rate over toolCalled/toolNotCalled assertions. */
  toolSelectionAccuracy: number;
  /**
   * Of responses that escalated, share with the expected target.
   * Null when no case carries an escalatedTo assertion.
   */
  escalationPrecision: number | null;
  /**
   * Of cases expecting escalation, share escalated to the expected target.
   * Null when no case expects escalation.
   */
  escalationRecall: number | null;
  /** Share of noDisclosureAbove assertions that failed. */
  unauthorizedDisclosureRate: number;
  /** Share of cases that timed out. */
  timeoutRate: number;
  avgLatencyMs: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface CaseReportEntry {
  caseId: string;
  category: EvalCategory;
  title: string;
  passed: boolean;
  timedOut: boolean;
  latencyMs: number;
  assertions: { type: string; passed: boolean; detail: string }[];
  /** First 300 chars of the answer, included only for failed cases. */
  answerPreview?: string;
  error?: string;
}

export interface EvaluationReport {
  reportId: string;
  generatedAt: string;
  systemName: string;
  dataset: {
    name: string;
    version: string;
    frozen: boolean;
    caseCount: number;
  };
  summary: {
    total: number;
    passed: number;
    failed: number;
    timedOut: number;
    score: number;
  };
  perCategory: Record<EvalCategory, CategoryScore>;
  metrics: EvalMetrics;
  cases: CaseReportEntry[];
}

const FACTUAL_ASSERTIONS = new Set([
  'contains',
  'notContains',
  'matches',
  'notMatches',
  'answerEquals',
  'answered',
]);

function emptyCategoryScore(): CategoryScore {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    score: 0,
    assertionsPassed: 0,
    assertionsFailed: 0,
  };
}

export function generateReport(
  systemName: string,
  dataset: { name: string; version: string; frozen: boolean },
  caseResults: CaseResult[],
  responses: { answer?: string; escalated?: string; tokens?: number; costUsd?: number }[],
): EvaluationReport {
  const perCategory = Object.fromEntries(
    EVAL_CATEGORIES.map((c) => [c, emptyCategoryScore()]),
  ) as Record<EvalCategory, CategoryScore>;

  const entries: CaseReportEntry[] = caseResults.map((r, i) => {
    const cat = perCategory[r.category];
    cat.total += 1;
    if (r.passed) cat.passed += 1;
    else cat.failed += 1;
    for (const a of r.assertions) {
      if (a.passed) cat.assertionsPassed += 1;
      else cat.assertionsFailed += 1;
    }
    const resp = responses[i];
    const entry: CaseReportEntry = {
      caseId: r.caseId,
      category: r.category,
      title: r.title,
      passed: r.passed,
      timedOut: r.timedOut,
      latencyMs: r.latencyMs,
      assertions: r.assertions.map((a) => ({
        type: a.assertion.type,
        passed: a.passed,
        detail: a.detail,
      })),
    };
    if (!r.passed && resp?.answer) {
      entry.answerPreview = resp.answer.slice(0, 300);
    }
    if (r.error !== undefined) entry.error = r.error;
    return entry;
  });

  for (const c of EVAL_CATEGORIES) {
    const cat = perCategory[c];
    cat.score = cat.total === 0 ? 0 : cat.passed / cat.total;
  }

  // ---- metrics -----------------------------------------------------------
  const total = caseResults.length;
  const passed = caseResults.filter((r) => r.passed).length;
  const timedOut = caseResults.filter((r) => r.timedOut).length;

  let factualPassed = 0;
  let factualTotal = 0;
  let sourcePassed = 0;
  let sourceTotal = 0;
  let hallucinatedCases = 0;
  let toolPassed = 0;
  let toolTotal = 0;
  let disclosureFailed = 0;
  let disclosureTotal = 0;

  // Escalation labels come from escalatedTo assertions.
  const escExpected: string[] = [];
  const escActual: string[] = [];

  caseResults.forEach((r, i) => {
    let caseHasFactualFailure = false;
    for (const a of r.assertions) {
      const t = a.assertion.type;
      if (FACTUAL_ASSERTIONS.has(t)) {
        factualTotal += 1;
        if (a.passed) factualPassed += 1;
        else caseHasFactualFailure = true;
      }
      if (t === 'sourceUsed') {
        sourceTotal += 1;
        if (a.passed) sourcePassed += 1;
      }
      if (t === 'toolCalled' || t === 'toolNotCalled') {
        toolTotal += 1;
        if (a.passed) toolPassed += 1;
      }
      if (t === 'noDisclosureAbove') {
        disclosureTotal += 1;
        if (!a.passed) disclosureFailed += 1;
      }
      if (t === 'escalatedTo') {
        escExpected.push((a.assertion as { target: string }).target);
        escActual.push(responses[i]?.escalated ?? 'none');
      }
    }
    if (caseHasFactualFailure) hallucinatedCases += 1;
  });

  const staleCases = caseResults.filter((r) => r.category === 'stale-facts');
  const staleFailed = staleCases.filter((r) => !r.passed).length;

  let escalationPrecision: number | null = null;
  let escalationRecall: number | null = null;
  if (escExpected.length > 0) {
    const escalatedIdx = escActual
      .map((a, i) => (a !== 'none' ? i : -1))
      .filter((i) => i >= 0);
    if (escalatedIdx.length > 0) {
      const correct = escalatedIdx.filter((i) => escActual[i] === escExpected[i]).length;
      escalationPrecision = correct / escalatedIdx.length;
    } else {
      escalationPrecision = 0;
    }
    const needsEscalation = escExpected
      .map((e, i) => (e !== 'none' ? i : -1))
      .filter((i) => i >= 0);
    if (needsEscalation.length > 0) {
      const correct = needsEscalation.filter((i) => escActual[i] === escExpected[i]).length;
      escalationRecall = correct / needsEscalation.length;
    }
  }

  const avgLatencyMs =
    total === 0 ? 0 : caseResults.reduce((s, r) => s + r.latencyMs, 0) / total;
  const totalTokens = responses.reduce((s, r) => s + (r.tokens ?? 0), 0);
  const totalCostUsd = responses.reduce((s, r) => s + (r.costUsd ?? 0), 0);

  const metrics: EvalMetrics = {
    overallScore: total === 0 ? 0 : passed / total,
    factualCorrectness: factualTotal === 0 ? 0 : factualPassed / factualTotal,
    sourceCorrectness: sourceTotal === 0 ? 0 : sourcePassed / sourceTotal,
    staleAnswerRate: staleCases.length === 0 ? 0 : staleFailed / staleCases.length,
    hallucinationRate: total === 0 ? 0 : hallucinatedCases / total,
    toolSelectionAccuracy: toolTotal === 0 ? 0 : toolPassed / toolTotal,
    escalationPrecision,
    escalationRecall,
    unauthorizedDisclosureRate:
      disclosureTotal === 0 ? 0 : disclosureFailed / disclosureTotal,
    timeoutRate: total === 0 ? 0 : timedOut / total,
    avgLatencyMs: Math.round(avgLatencyMs * 10) / 10,
    totalTokens,
    totalCostUsd: Math.round(totalCostUsd * 1e6) / 1e6,
  };

  const now = new Date();
  return {
    reportId: `eval-${now.toISOString().replace(/[:.]/g, '-')}-${Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, '0')}`,
    generatedAt: now.toISOString(),
    systemName,
    dataset: {
      name: dataset.name,
      version: dataset.version,
      frozen: dataset.frozen,
      caseCount: total,
    },
    summary: {
      total,
      passed,
      failed: total - passed,
      timedOut,
      score: metrics.overallScore,
    },
    perCategory,
    metrics,
    cases: entries,
  };
}

/** Serialize a report to canonical JSON (stable key order not guaranteed). */
export function reportToJson(report: EvaluationReport): string {
  return JSON.stringify(report, null, 2);
}

/** Write the report JSON to disk. */
export async function writeReport(
  report: EvaluationReport,
  filePath: string,
): Promise<void> {
  await writeFile(filePath, reportToJson(report), 'utf-8');
}

/** One-line-per-category human summary (markdown) for PRs / CI logs. */
export function renderMarkdownSummary(report: EvaluationReport): string {
  const lines: string[] = [
    `# Evaluation report: ${report.systemName}`,
    '',
    `- dataset: ${report.dataset.name} ${report.dataset.version}${report.dataset.frozen ? ' (frozen)' : ' (NOT frozen — seed)'}`,
    `- score: ${(report.summary.score * 100).toFixed(1)}% (${report.summary.passed}/${report.summary.total} cases)`,
    `- timeouts: ${report.summary.timedOut}`,
    '',
    '| category | passed | total | score |',
    '| --- | --- | --- | --- |',
  ];
  for (const c of EVAL_CATEGORIES) {
    const s = report.perCategory[c];
    lines.push(
      `| ${c} | ${s.passed} | ${s.total} | ${(s.score * 100).toFixed(0)}% |`,
    );
  }
  lines.push('', '## metrics', '');
  const m = report.metrics;
  lines.push(
    `- factual correctness: ${(m.factualCorrectness * 100).toFixed(1)}%`,
    `- source correctness: ${(m.sourceCorrectness * 100).toFixed(1)}%`,
    `- stale-answer rate: ${(m.staleAnswerRate * 100).toFixed(1)}%`,
    `- hallucination rate (proxy): ${(m.hallucinationRate * 100).toFixed(1)}%`,
    `- tool-selection accuracy: ${(m.toolSelectionAccuracy * 100).toFixed(1)}%`,
    `- escalation precision: ${m.escalationPrecision === null ? 'n/a' : `${(m.escalationPrecision * 100).toFixed(1)}%`}`,
    `- escalation recall: ${m.escalationRecall === null ? 'n/a' : `${(m.escalationRecall * 100).toFixed(1)}%`}`,
    `- unauthorized-disclosure rate: ${(m.unauthorizedDisclosureRate * 100).toFixed(1)}%`,
    `- timeout rate: ${(m.timeoutRate * 100).toFixed(1)}%`,
    `- avg latency: ${m.avgLatencyMs}ms · tokens: ${m.totalTokens} · cost: $${m.totalCostUsd}`,
  );
  return lines.join('\n');
}
