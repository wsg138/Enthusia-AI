/**
 * Golden tests — pinned input/output pairs for agent behavior.
 *
 * Populated by W20 (evaluation): runs the seed golden dataset
 * (MASTER-SPECIFICATION.md §29.1) against the reference mock system.
 * No real model exists yet; this pins the harness + dataset contract so
 * regressions in either are caught by CI.
 */
import { describe, expect, it } from 'vitest';
import {
  runCases,
  validateGoldenDataset,
  idealSystem,
  SEED_GOLDEN_CASES,
  GOLDEN_DATASET_NAME,
  GOLDEN_DATASET_VERSION,
} from '../../training/evaluation/src/index.js';

describe(`golden evaluation suite (${GOLDEN_DATASET_NAME} ${GOLDEN_DATASET_VERSION})`, () => {
  it('dataset validates and covers every spec §29.1 category', () => {
    const { categoriesCovered, missingCategories } =
      validateGoldenDataset(SEED_GOLDEN_CASES);
    expect(missingCategories).toEqual([]);
    expect(categoriesCovered.length).toBeGreaterThan(0);
  });

  it('reference mock system passes every golden case', async () => {
    const results = await runCases(idealSystem, SEED_GOLDEN_CASES);
    const failed = results.filter((r) => !r.passed);
    expect(
      failed.map(
        (f) =>
          `${f.caseId}: ${f.assertions
            .filter((a) => !a.passed)
            .map((a) => a.detail)
            .join('; ')}`,
      ),
    ).toEqual([]);
  }, 60_000);
});
