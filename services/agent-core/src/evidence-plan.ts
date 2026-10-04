/**
 * @enthusia/agent-core — evidence planning (W12).
 *
 * Spec §15.1 steps 2–4: identify claims needed to answer, identify relevant
 * context, select authoritative sources. The reasoner drafts the plan; the
 * orchestrator validates it:
 *
 * - every step references a known claim (unknown claims are kept but marked,
 *   so investigation can still use them without polluting the answer);
 * - every candidate tool must exist in the registry (unknown tools are
 *   dropped — the model may not invent tools);
 * - privacy-sensitive steps are only usable when the classification says the
 *   request needs private context (the execution-time gate re-checks this).
 */
import type { ChatRequest } from '@enthusia/contracts';
import type { Reasoner } from './reasoner.js';
import type { ToolRegistry } from './tool.js';
import type {
  EvidencePlanStep,
  IntentClassification,
  VerificationTier,
} from './types.js';
import { VERIFICATION_TIERS } from './types.js';
import type { ReasonerAccounting } from './intent.js';

/** A validated evidence plan. */
export interface EvidencePlan {
  steps: EvidencePlanStep[];
  /** Warnings produced during validation (unknown tools dropped, ...). */
  warnings: string[];
}

/** Build and validate the evidence plan for a classified request. */
export async function buildEvidencePlan(
  reasoner: Reasoner,
  request: ChatRequest,
  classification: IntentClassification,
  registry: ToolRegistry,
  accounting?: ReasonerAccounting,
): Promise<EvidencePlan> {
  accounting?.recordReasonerCalls(1);
  const raw = await reasoner.planEvidence(
    request,
    classification,
    registry.list(),
  );
  return normalizePlan(raw, classification, registry);
}

/** Validate/normalize a raw plan (also used by tests). */
export function normalizePlan(
  raw: EvidencePlanStep[],
  classification: IntentClassification,
  registry: ToolRegistry,
): EvidencePlan {
  const warnings: string[] = [];
  const steps: EvidencePlanStep[] = [];
  const knownClaims = new Set(classification.claims);

  if (!Array.isArray(raw)) {
    throw new Error('evidence plan must be an array');
  }

  for (const [index, step] of raw.entries()) {
    if (!step || typeof step !== 'object') {
      warnings.push(`plan step ${index}: not an object, dropped`);
      continue;
    }
    const claim =
      typeof step.claim === 'string' && step.claim.trim().length > 0
        ? step.claim.trim()
        : null;
    if (!claim) {
      warnings.push(`plan step ${index}: missing claim, dropped`);
      continue;
    }
    if (!knownClaims.has(claim)) {
      warnings.push(
        `plan step ${index}: claim "${claim}" was not in the classification; keeping as auxiliary`,
      );
    }
    const tier = isVerificationTier(step.verificationTier)
      ? step.verificationTier
      : 'B';
    if (!isVerificationTier(step.verificationTier)) {
      warnings.push(
        `plan step "${claim}": invalid verification tier, defaulting to B`,
      );
    }
    const candidateTools = Array.isArray(step.candidateTools)
      ? step.candidateTools.filter((name): name is string => {
          if (typeof name !== 'string' || !registry.has(name)) {
            warnings.push(
              `plan step "${claim}": unknown tool "${String(name)}", dropped`,
            );
            return false;
          }
          return true;
        })
      : [];
    if (candidateTools.length === 0) {
      warnings.push(`plan step "${claim}": no usable tools, dropped`);
      continue;
    }
    let params: Record<string, unknown> | undefined;
    if (step.params !== undefined) {
      if (isPlainObject(step.params)) {
        params = step.params;
      } else {
        warnings.push(`plan step "${claim}": params not an object, dropped`);
      }
    }
    steps.push({
      claim,
      candidateTools,
      verificationTier: tier,
      privacySensitive: step.privacySensitive === true,
      ...(params !== undefined ? { params } : {}),
    });
  }

  return { steps, warnings };
}

function isVerificationTier(value: unknown): value is VerificationTier {
  return (
    typeof value === 'string' &&
    (VERIFICATION_TIERS as readonly string[]).includes(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}
