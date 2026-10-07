/**
 * @enthusia/moderation-adapter — isolated moderation sibling adapter (W15).
 *
 * Public surface:
 * - ModerationAdapter — fire-and-forget context enrichment + status query,
 *   never blocking support on moderation health.
 * - ModerationServiceClient — raw HTTP client for the moderation API
 *   (direct connection; never via the AI Gateway).
 * - CircuitBreaker — failure isolation so a downed moderation service
 *   costs support zero blocking time once the circuit opens.
 * - SharedIdentityMetadata + moderation wire/context types.
 *
 * Spec: MASTER-SPECIFICATION.md §10.1 (separate moderation and support
 * models), §21 (moderation integration), §36 (observability).
 */

export { ModerationAdapter } from './adapter.js';
export type {
  EnrichmentRequestOptions,
  EnrichmentResult,
  ModerationAdapterOptions,
} from './adapter.js';

export { ModerationServiceClient } from './client.js';
export type { ModerationClientOptions } from './client.js';

export { CircuitBreaker } from './circuit-breaker.js';
export type { CircuitBreakerOptions, CircuitBreakerStats } from './circuit-breaker.js';

export type {
  CircuitState,
  DecisionContextRequest,
  FetchFn,
  ModerationContainment,
  ModerationDecision,
  ModerationDecisionContext,
  ModerationDecisionSource,
  ModerationHealthWireResponse,
  ModerationMessageAction,
  ModerationPlatform,
  ModerationReviewPriority,
  ModerationSemanticLabel,
  ModerationServiceStatus,
  ModerationStrikeRecommendation,
  ModerationSupportFlow,
  SharedIdentityMetadata,
  SupportContextWireResponse,
} from './types.js';
