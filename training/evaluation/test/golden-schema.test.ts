/**
 * Unit tests: golden dataset schema validation.
 */
import { describe, expect, it } from 'vitest';
import { EVAL_CATEGORIES } from '../src/index.js';
import {
  validateEvalCase,
  validateGoldenDataset,
  validateFrozenGoldenDataset,
  SEED_GOLDEN_CASES,
} from '../src/index.js';

const validCase = {
  id: 'onboarding-001',
  category: 'onboarding',
  title: 't',
  question: 'q?',
  assertions: [{ type: 'contains', value: 'x' }],
};

describe('validateEvalCase', () => {
  it('accepts a well-formed case', () => {
    expect(() => validateEvalCase(validCase)).not.toThrow();
  });

  it('rejects unknown categories', () => {
    expect(() => validateEvalCase({ ...validCase, category: 'nope' })).toThrow();
  });

  it('rejects non-kebab-case ids', () => {
    expect(() => validateEvalCase({ ...validCase, id: 'Bad_ID' })).toThrow();
  });

  it('rejects empty assertion lists', () => {
    expect(() => validateEvalCase({ ...validCase, assertions: [] })).toThrow();
  });

  it('rejects unknown assertion types', () => {
    expect(() =>
      validateEvalCase({ ...validCase, assertions: [{ type: 'telepathy' }] }),
    ).toThrow();
  });

  it('rejects unknown fields (strict schema)', () => {
    expect(() => validateEvalCase({ ...validCase, bogus: 1 })).toThrow();
  });
});

describe('validateGoldenDataset', () => {
  it('seed corpus validates and covers every spec category', () => {
    const { categoriesCovered, missingCategories } = validateGoldenDataset(SEED_GOLDEN_CASES);
    expect(missingCategories).toEqual([]);
    expect(categoriesCovered).toHaveLength(EVAL_CATEGORIES.length);
    for (const c of EVAL_CATEGORIES) {
      expect(categoriesCovered).toContain(c);
    }
  });

  it('refuses to freeze the unreviewed seed corpus', () => {
    expect(() => validateFrozenGoldenDataset(SEED_GOLDEN_CASES)).toThrow(
      /unreviewed cases/,
    );
  });

  it('accepts a fully covered reviewed dataset for freezing', () => {
    const reviewed = SEED_GOLDEN_CASES.map((testCase) => ({
      ...testCase,
      ownerReviewed: true,
    }));
    expect(() => validateFrozenGoldenDataset(reviewed)).not.toThrow();
  });

  it('rejects duplicate case ids', () => {
    const dupes = [validCase, { ...validCase, title: 'other' }];
    expect(() => validateGoldenDataset(dupes)).toThrow(/duplicate/);
  });
});
