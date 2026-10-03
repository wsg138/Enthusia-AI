/**
 * @enthusia/discord-bot — Enthusia AI Discord bot (W06).
 *
 * Public surface of the Discord adapter. The bot core is driven through the
 * `DiscordClientPort`; `discord-js-client.ts` adapts a real discord.js
 * Client, and tests inject mocks — no live Discord connection required.
 *
 * Spec: MASTER-SPECIFICATION.md §6.1 (Discord bot), §18 (Discord behavior),
 * §36 (health/observability). WORKER-EXECUTION-PLAN.md §9 (W06).
 */

// Port types (no discord.js dependency).
export type {
  DiscordChannelInfo,
  DiscordChannelKind,
  DiscordClientPort,
  DiscordGuildInfo,
  DiscordMemberInfo,
  DiscordMessageRef,
  DiscordRoleInfo,
  DiscordSlashAskRef,
  DiscordUserInfo,
  OutgoingDiscordMessage,
  Snowflake,
} from './types.js';

// Configuration.
export { resolveDiscordBotOptions, type DiscordBotOptions, type RateLimitScopeConfig } from './config.js';

// Trigger policy.
export {
  decideSlashTrigger,
  decideTrigger,
  extractPrompt,
  type TriggerDecision,
  type TriggerKind,
} from './policy.js';

// Actor context extraction.
export {
  displayNameFor,
  extractMessageContext,
  extractSlashAskContext,
  mapRoles,
  type ExtractedActorContext,
} from './context.js';

// Response formatting.
export {
  DISCORD_MAX_MESSAGE_CHARS,
  formatAgentResponse,
  neutralizeMassMentions,
  splitIntoDiscordMessages,
} from './formatting.js';

// Rate limiting.
export {
  DiscordRateLimitPolicy,
  TokenBucketRateLimiter,
  type RateLimitCheckResult,
  type RateLimitDecision,
  type RateLimitScope,
} from './rate-limit.js';

// AI Gateway client.
export {
  HttpAiGatewayClient,
  MockAiGatewayClient,
  createGatewayClient,
  type AiGatewayClient,
} from './gateway-client.js';

// Bot orchestration.
export { EnthusiaAiDiscordBot, type HandleOutcome, type HandleResult } from './bot.js';

// discord.js adapter (the only module importing discord.js).
export {
  AI_ASK_QUESTION_OPTION,
  AI_ASK_SUBCOMMAND,
  AI_COMMAND_NAME,
  DiscordJsClientAdapter,
  buildAiSlashCommand,
  normalizeMessage,
  normalizeSlashAsk,
  type DiscordJsClientOptions,
} from './discord-js-client.js';

// Health reporting.
export { buildHealthReport, type DiscordBotHealth, type HealthDependency } from './health.js';

// Deployment entrypoint.
export { startBotFromEnv, type StartedBot } from './startup.js';
