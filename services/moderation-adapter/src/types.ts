/**
 * Shared types for the moderation adapter (W15).
 *
 * The moderation model/runtime remains a sibling service with independent
 * health and release lineage. These types intentionally mirror only the
 * privacy-minimized support-context contract exposed by AI-Moderation-API.
 */

export type FetchFn = typeof fetch;

export type ModerationPlatform = 'minecraft' | 'discord';

export type ModerationSemanticLabel =
  | 'SAFE'
  | 'GAMEPLAY_VIOLENCE'
  | 'LOW_LEVEL_HARASSMENT'
  | 'SEVERE_HARASSMENT'
  | 'STAFF_TARGETED_ABUSE'
  | 'REAL_WORLD_THREAT'
  | 'SELF_HARM_INSTRUCTION'
  | 'SELF_HARM_INTENT'
  | 'THIRD_PARTY_SELF_HARM_CONCERN'
  | 'HATE'
  | 'SLUR_USE'
  | 'SEXUAL_CONTENT'
  | 'SEXUAL_MINOR'
  | 'DOXXING'
  | 'BLACKMAIL'
  | 'GROOMING'
  | 'DANGEROUS_REAL_WORLD_INSTRUCTIONS'
  | 'AMBIGUOUS_REVIEW';

export type ModerationMessageAction = 'ALLOW' | 'BLOCK';
export type ModerationReviewPriority = 'NONE' | 'NORMAL' | 'URGENT';
export type ModerationStrikeRecommendation = 'NONE' | 'EVIDENCE' | 'STRIKE';
export type ModerationContainment = 'NONE' | 'MUTE';
export type ModerationSupportFlow =
  | 'NONE'
  | 'SELF_HARM_CHECK'
  | 'TARGET_SAFETY_CHECK';
export type ModerationDecisionSource = 'AI' | 'ACCEPTED_CORRECTION';

/**
 * Privacy-minimized effective moderation decision returned to support.
 *
 * Raw message text, platform sender IDs, channels/scopes, neighboring chat,
 * and review internals are deliberately absent.
 */
export interface ModerationDecision {
  eventId: string;
  occurredAt: string;
  platform: ModerationPlatform;
  semanticLabel: ModerationSemanticLabel;
  messageAction: ModerationMessageAction;
  reviewPriority: ModerationReviewPriority;
  strikeRecommendation: ModerationStrikeRecommendation;
  containment: ModerationContainment;
  supportFlow: ModerationSupportFlow;
  reasonCodes: readonly string[];
  decisionSource: ModerationDecisionSource;
}

/**
 * Optional moderation history attached to support context.
 *
 * `subjectId` is the support-side subject. Decisions came from the separate
 * moderation service and must never be treated as a live moderation verdict.
 */
export interface ModerationDecisionContext {
  subjectId: string;
  decisions: readonly ModerationDecision[];
  fetchedAt: string;
  stale: boolean;
}

/**
 * Shared identity mapping (§21.2).
 *
 * `moderationSubjectId` MUST be an authoritative canonical identity ID that
 * the trusted moderation integration previously supplied as
 * `sender_identity_id`. Usernames/raw platform IDs are not valid substitutes.
 */
export interface SharedIdentityMetadata {
  supportSubjectId: string;
  moderationSubjectId: string;
  displayLabel?: string;
}

export interface DecisionContextRequest {
  subjectId: string;
  /** Maximum decisions to return. AI-Moderation-API clamps this to 1..25. */
  limit?: number;
}

/** Minimal validated subset of GET /health/ready. */
export interface ModerationHealthWireResponse {
  status: 'ready' | 'not_ready';
  ready: boolean;
  schema_version: number | null;
}

/** Exact privacy-safe wire shape from GET /v1/support-context/{subject_id}. */
export interface SupportContextWireResponse {
  subject_id: string;
  decisions: Array<{
    event_id: string;
    occurred_at: string;
    platform: ModerationPlatform;
    semantic_label: ModerationSemanticLabel;
    message_action: ModerationMessageAction;
    review_priority: ModerationReviewPriority;
    strike_recommendation: ModerationStrikeRecommendation;
    containment: ModerationContainment;
    support_flow: ModerationSupportFlow;
    reason_codes: string[];
    decision_source: ModerationDecisionSource;
  }>;
}

export type ModerationServiceStatus =
  | 'reachable'
  | 'degraded'
  | 'unreachable'
  | 'circuit-open';

export type CircuitState = 'closed' | 'open' | 'half-open';
