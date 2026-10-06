/**
 * @enthusia/player-identity — public API (W11).
 *
 * Spec: MASTER-SPECIFICATION.md §68, §69.
 */
export type {
  BedrockIdentity,
  IdentityField,
  IdentityFieldValues,
  IdentityPurpose,
  IdentityRequester,
  PlayerIdentity,
  RankContext,
  RelevantContext,
  UsernameRecord,
  WithheldField,
} from './types.js';
export {
  IDENTITY_FIELD_VISIBILITY,
  IDENTITY_PURPOSES,
  PURPOSE_FIELDS,
  identityFieldValues,
  isIdentityPurpose,
} from './types.js';

export type { IdentityStore } from './store.js';
export {
  IdentityStoreError,
  InMemoryIdentityStore,
  isValidDiscordId,
  isValidUsername,
  isValidUuid,
} from './store.js';

export type { ResolvedIdentity } from './service.js';
export {
  IdentityServiceError,
  isSubjectOrStaff,
  PlayerIdentityService,
} from './service.js';

export type {
  IdentityContextParams,
  IdentityResolveParams,
  Tool,
  ToolCallContext,
  ToolMetadata,
  ToolParameterProperty,
  ToolParametersSchema,
} from './tool.js';
export {
  IdentityContextTool,
  IdentityResolveTool,
  requesterFromActor,
} from './tool.js';

// Topic-specific familiarity hint (issue #33)
export {
  TOPIC_FAMILIARITY_BASIS,
  TOPIC_FAMILIARITY_LEVELS,
  TopicFamiliarityTool,
} from './familiarity.js';
export type {
  TopicFamiliarityBasis,
  TopicFamiliarityLevel,
  TopicFamiliarityProvider,
  TopicFamiliaritySignal,
} from './familiarity.js';
