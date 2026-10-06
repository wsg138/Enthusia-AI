/**
 * @enthusia/agent-core — intent classification (W12).
 *
 * Spec §15.1 step 1 ("understand intent"). Classification goes through the
 * reasoner (local model), but the orchestrator validates the result:
 * request class must be a known class, claims must be non-empty strings,
 * flags must be booleans. Invalid model output fails the request safely
 * rather than inventing an intent.
 */
import type { ChatRequest } from '@enthusia/contracts';
import type { Reasoner } from './reasoner.js';
import type { IntentClassification } from './types.js';
import { isRequestClass } from './types.js';

/** Reasoner-call accounting hook (the orchestrator passes its tracker). */
export interface ReasonerAccounting {
  recordReasonerCalls(count?: number): void;
}

/**
 * Classify the request's intent via the reasoner and validate the result.
 * Throws on invalid model output (fail safe — never invent an intent).
 */
export async function classifyIntent(
  reasoner: Reasoner,
  request: ChatRequest,
  accounting?: ReasonerAccounting,
): Promise<IntentClassification> {
  accounting?.recordReasonerCalls(1);
  const raw = await reasoner.classifyIntent(request);
  return normalizeClassification(raw);
}

/** Validate/normalize a raw classification (also used by tests). */
export function normalizeClassification(
  raw: IntentClassification,
): IntentClassification {
  if (!raw || typeof raw !== 'object') {
    throw new Error('intent classification must be an object');
  }
  if (!isRequestClass(raw.requestClass)) {
    throw new Error(
      `unknown request class: ${String((raw as { requestClass?: unknown }).requestClass)}`,
    );
  }
  const claims = Array.isArray(raw.claims)
    ? [...new Set(
        raw.claims
          .filter(
            (claim): claim is string =>
              typeof claim === 'string' && claim.trim().length > 0,
          )
          .map((claim) => claim.trim()),
      )]
    : [];
  const claimSet = new Set(claims);
  const backgroundClaims = Array.isArray(raw.backgroundClaims)
    ? [...new Set(
        raw.backgroundClaims
          .filter(
            (claim): claim is string =>
              typeof claim === 'string' && claim.trim().length > 0,
          )
          .map((claim) => claim.trim())
          .filter((claim) => claimSet.has(claim)),
      )]
    : [];
  const familiarityTopic =
    typeof raw.familiarityTopic === 'string' &&
    raw.familiarityTopic.trim().length > 0
      ? raw.familiarityTopic.trim().replace(/\s+/g, ' ').slice(0, 160)
      : undefined;

  return {
    requestClass: raw.requestClass,
    summary:
      typeof raw.summary === 'string' && raw.summary.trim().length > 0
        ? raw.summary.trim()
        : '(no summary)',
    claims,
    ...(backgroundClaims.length > 0 ? { backgroundClaims } : {}),
    ...(raw.needsFamiliarityContext === true
      ? { needsFamiliarityContext: true }
      : {}),
    ...(familiarityTopic !== undefined ? { familiarityTopic } : {}),
    needsPrivateContext: raw.needsPrivateContext === true,
    securitySensitive: raw.securitySensitive === true,
    ...(typeof raw.reasoning === 'string' && raw.reasoning.length > 0
      ? { reasoning: raw.reasoning }
      : {}),
  };
}
