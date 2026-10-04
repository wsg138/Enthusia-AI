/**
 * Shared types for the moderation adapter (W15).
 *
 * Moderation is a sibling system (MASTER-SPECIFICATION.md §21): a separate
 * process, separate model, independent health. These types describe the
 * moderation service's wire API and the context the support side may
 * *optionally* consume. No real-time moderation is ever routed through the
 * support LLM (§10.1), and nothing here depends on AI Gateway availability.
 *
 * The moderation API itself is external to this monorepo. The types below
 * are the adapter's expectation of that API; there is NO real moderation
 * service connection in tests or in this implementation — tests inject a
 * mock fetch.
 */

/**
 * Minimal injectable fetch shape. The adapter never reaches for a global
 * fetch directly; the implementation to use is supplied by configuration
 * (globalThis.fetch by default, a mock in tests).
 */
export type FetchFn = typeof fetch;

/** Classification outcome of a single moderation decision. */
export type ModerationVerdict = 'clean' | 'flagged' | 'blocked';

/**
 * One moderation decision made by the separate moderation model.
 * Read-only context for support; the support side never mutates or
 * re-derives these — they are evidence of what the sibling system did.
 */
export interface ModerationDecision {
  /** Opaque decision ID from the moderation service. */
  id: string;
  /** Identity the decision applies to (opaque to the adapter). */
  subjectId: string;
  verdict: ModerationVerdict;
  /** Machine-readable category codes, e.g. 'spam', 'harassment'. */
  categories: readonly string[];
  /** Human-readable summary the support side may quote. */
  summary: string;
  /** ISO-8601 timestamp when the moderation model made the decision. */
  decidedAt: string;
  /** Whether a staff member upheld/overturned this decision. */
  appealed?: boolean;
}

/**
 * Decision context returned to the support side: recent moderation history
 * for an identity, usable only as optional support context. It is *not*
 * a real-time moderation verdict and must never gate a support response.
 */
export interface ModerationDecisionContext {
  /** Identity the context was fetched for (see SharedIdentityMetadata). */
  subjectId: string;
  /** Recent decisions, newest first. Empty array is a valid result. */
  decisions: readonly ModerationDecision[];
  /** ISO-8601 timestamp when this context was fetched. */
  fetchedAt: string;
  /** Whether the fetch hit the live service or a fallback. */
  stale: boolean;
}

/**
 * Shared identity metadata (§21.2 "identity mapping"). The moderation
 * service and the support side identify users differently; this maps one
 * to the other. All fields are opaque strings — the adapter never
 * interprets identity values, only forwards them.
 */
export interface SharedIdentityMetadata {
  /** Canonical support-side identity, e.g. the linked player identity. */
  supportSubjectId: string;
  /** Moderation-service identity (forwarded verbatim to its API). */
  moderationSubjectId: string;
  /** Optional human-readable label for logs/debugging (never secret). */
  displayLabel?: string;
}

/** Payload sent to the moderation API's context endpoint. */
export interface DecisionContextRequest {
  subjectId: string;
  /** Maximum decisions to return (server-clamped). */
  limit?: number;
}

/** Wire response from GET /health on the moderation service. */
export interface ModerationHealthWireResponse {
  status: 'ok' | 'degraded' | 'down';
  version?: string;
}

/** Wire response from POST /v1/decisions/context. */
export interface DecisionContextWireResponse {
  subjectId: string;
  decisions: Array<{
    id: string;
    subjectId: string;
    verdict: ModerationVerdict;
    categories: string[];
    summary: string;
    decidedAt: string;
    appealed?: boolean;
  }>;
}

/** Status of the moderation service as observed by the adapter. */
export type ModerationServiceStatus = 'reachable' | 'degraded' | 'unreachable' | 'circuit-open';

/** Breaker state for observability. */
export type CircuitState = 'closed' | 'open' | 'half-open';
