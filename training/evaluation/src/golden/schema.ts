/**
 * Golden dataset schema validation (zod).
 *
 * Every golden case must validate before it can enter a frozen dataset.
 * ownerReviewed cases are additionally expected to carry a non-empty title
 * and at least one assertion (a reviewed case with no assertions proves nothing).
 */
import { z } from 'zod';
import { EVAL_CATEGORIES } from '../types.js';

const visibilityClassSchema = z.enum([
  'PUBLIC',
  'PLAYER_SELF',
  'STAFF',
  'MANAGEMENT',
  'SYSTEM_INTERNAL',
  'SECRET_DENY',
]);

const assertionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('contains'),
    value: z.string().min(1),
    caseSensitive: z.boolean().optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('notContains'),
    value: z.string().min(1),
    caseSensitive: z.boolean().optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('matches'),
    pattern: z.string().min(1),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('notMatches'),
    pattern: z.string().min(1),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('answerEquals'),
    value: z.string(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('answered'),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('escalatedTo'),
    target: z.enum(['none', 'openai', 'staff']),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('toolCalled'),
    tool: z.string().min(1),
    maxCalls: z.number().int().positive().optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('toolNotCalled'),
    tool: z.string().min(1),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('sourceUsed'),
    source: z.string().min(1),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('noDisclosureAbove'),
    ceiling: visibilityClassSchema,
    isStaff: z.boolean().optional(),
    isSubject: z.boolean().optional(),
    forbidden: z.array(z.string().min(1)).optional(),
    message: z.string().optional(),
  }),
]);

const evalContextSchema = z.object({
  requesterVisibility: visibilityClassSchema,
  isStaff: z.boolean().optional(),
  isSubject: z.boolean().optional(),
  requesterId: z.string().optional(),
  sources: z.record(z.string(), z.unknown()).optional(),
  nowIso: z.string().optional(),
});

export const evalCaseSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'id must be kebab-case'),
    category: z.enum(EVAL_CATEGORIES),
    title: z.string().min(1),
    question: z.string().min(1),
    context: evalContextSchema.partial().optional(),
    assertions: z.array(assertionSchema).min(1),
    tags: z.array(z.string()).optional(),
    ownerReviewed: z.boolean().optional(),
  })
  .strict();

export type EvalCaseInput = z.infer<typeof evalCaseSchema>;

/** Validate a single case. Returns the parsed case or throws ZodError. */
export function validateEvalCase(input: unknown): EvalCaseInput {
  return evalCaseSchema.parse(input);
}

/** Validate a whole dataset: schema + id uniqueness + category coverage. */
export function validateGoldenDataset(cases: unknown[]): {
  cases: EvalCaseInput[];
  categoriesCovered: string[];
  missingCategories: string[];
} {
  const parsed = cases.map((c) => evalCaseSchema.parse(c));
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const c of parsed) {
    if (seen.has(c.id)) dupes.push(c.id);
    seen.add(c.id);
  }
  if (dupes.length > 0) {
    throw new Error(`duplicate golden case ids: ${dupes.join(', ')}`);
  }
  const covered = new Set(parsed.map((c) => c.category));
  const missing = EVAL_CATEGORIES.filter((c) => !covered.has(c));
  return {
    cases: parsed,
    categoriesCovered: [...covered],
    missingCategories: missing,
  };
}


/**
 * Validate a dataset before it may be labeled frozen.
 * Frozen evaluation requires full category coverage and explicit owner/staff
 * review on every case; callers cannot turn seed data into a frozen benchmark
 * by changing metadata alone.
 */
export function validateFrozenGoldenDataset(cases: unknown[]): {
  cases: EvalCaseInput[];
  categoriesCovered: string[];
  missingCategories: string[];
} {
  const result = validateGoldenDataset(cases);
  if (result.missingCategories.length > 0) {
    throw new Error(
      `frozen golden dataset missing categories: ${result.missingCategories.join(', ')}`,
    );
  }
  const unreviewed = result.cases
    .filter((testCase) => testCase.ownerReviewed !== true)
    .map((testCase) => testCase.id);
  if (unreviewed.length > 0) {
    throw new Error(
      `frozen golden dataset contains unreviewed cases: ${unreviewed.join(', ')}`,
    );
  }
  return result;
}
