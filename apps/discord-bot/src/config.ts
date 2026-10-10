/**
 * @enthusia/discord-bot — bot configuration (W06).
 *
 * W06-owned settings live here, resolved from environment variables with
 * safe defaults. The Discord bot token is deliberately NOT resolved here:
 * it is a secret, and per Master Specification §5.5 / §17.6 secrets are held
 * by the deployment/tool layer. The token arrives via
 * `@enthusia/config`'s `loadConfig().discordBotToken` (env
 * `DISCORD_BOT_TOKEN`) and is passed to `startBotFromEnv` / the discord.js
 * adapter as an explicit argument — never logged, never embedded in a
 * ChatRequest (see startup.ts).
 *
 * Channel/role IDs are configuration, not secrets.
 */
import { Visibility } from '@enthusia/contracts';

/** Token-bucket settings for one rate-limit scope. */
export interface RateLimitScopeConfig {
  /** Maximum requests per window. */
  maxRequests: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** Everything the Discord bot needs besides the secret token. */
export interface DiscordBotOptions {
  /** Visible bot name ("Enthusia AI", §6.1). The exact name is owner-configurable. */
  botName: string;
  /** AI Gateway base URL, e.g. http://127.0.0.1:4100 (W02). */
  gatewayBaseUrl: string;
  /** Service credential used only on the AI Gateway HTTP request. */
  gatewayApiKey?: string;
  /**
   * When true, ChatRequests go to the in-process mock gateway instead of
   * HTTP. This is development/test only and is forbidden in production.
   */
  useMockGateway: boolean;
  /** HTTP timeout for gateway calls, in milliseconds. */
  gatewayTimeoutMs: number;
  /** Use only Guilds intent, slash commands; do not read ordinary messages. */
  slashOnly: boolean;
  /** Test-only: accept explicit @mentions only (no automatic channel replies). */
  mentionOnly: boolean;
  /** Optional safety scope for test deployments; empty means standard behavior. */
  allowedGuildIds: string[];
  /** Optional channel allowlist for ALL response triggers, including slash. */
  allowedChannelIds: string[];
  /** Configured AI/help channels: every message here is a trigger (§18.1). */
  aiChannelIds: string[];
  /** Staff-only AI channels: staff members get a STAFF visibility ceiling here. */
  staffChannelIds: string[];
  /** Configured test channel(s): every message here is a trigger. */
  testChannelIds: string[];
  /** Optional hard allowlist. When configured, rejects all other guilds, including DMs. */
  allowedGuildIds?: string[];
  /** Optional hard allowlist for message and slash interaction channels. */
  allowedChannelIds?: string[];
  /** Discord role IDs that mark an actor as staff (role context mapping). */
  staffRoleIds: string[];
  /** Default visibility ceiling for responses (§17). */
  defaultVisibilityCeiling: Visibility;
  /** Per-user rate limit (§18.4). */
  perUserRateLimit: RateLimitScopeConfig;
  /** Global rate limit across all users (§18.4). */
  globalRateLimit: RateLimitScopeConfig;
  /** Maximum Discord message length for one chunk (Discord limit is 2000). */
  maxMessageChars: number;
  /** Maximum chunks per response before truncation. */
  maxChunksPerResponse: number;
  /** Optional guild ID for guild-scoped slash-command registration. */
  slashCommandGuildId?: string;
}

function commaSeparatedList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
}

/**
 * Resolve bot options from the environment. Everything has a safe default;
 * a clean checkout runs the bot against the mock gateway with no channels
 * configured (it will only answer explicit mentions / `/ai ask`).
 */
export function resolveDiscordBotOptions(env: NodeJS.ProcessEnv = process.env): DiscordBotOptions {
  return {
    botName: env['ENTHUSIA_DISCORD_BOT_NAME']?.trim() || 'Enthusia AI',
    gatewayBaseUrl: env['ENTHUSIA_AI_GATEWAY_URL']?.trim() || 'http://127.0.0.1:4100',
    ...(env['ENTHUSIA_AI_GATEWAY_API_KEY']?.trim()
      ? { gatewayApiKey: env['ENTHUSIA_AI_GATEWAY_API_KEY']!.trim() }
      : {}),
    useMockGateway: envBool(env['ENTHUSIA_DISCORD_USE_MOCK_GATEWAY'], false),
    gatewayTimeoutMs: envInt(env['ENTHUSIA_DISCORD_GATEWAY_TIMEOUT_MS'], 30_000),
    slashOnly: envBool(env['ENTHUSIA_DISCORD_SLASH_ONLY'], false),
    mentionOnly: envBool(env['ENTHUSIA_DISCORD_MENTION_ONLY'], false),
    allowedGuildIds: commaSeparatedList(env['ENTHUSIA_DISCORD_ALLOWED_GUILD_IDS']),
    allowedChannelIds: commaSeparatedList(env['ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS']),
    aiChannelIds: commaSeparatedList(env['ENTHUSIA_DISCORD_AI_CHANNELS']),
    staffChannelIds: commaSeparatedList(env['ENTHUSIA_DISCORD_STAFF_CHANNELS']),
    testChannelIds: commaSeparatedList(env['ENTHUSIA_DISCORD_TEST_CHANNELS']),
    allowedGuildIds: commaSeparatedList(env['ENTHUSIA_DISCORD_ALLOWED_GUILD_IDS']),
    allowedChannelIds: commaSeparatedList(env['ENTHUSIA_DISCORD_ALLOWED_CHANNEL_IDS']),
    staffRoleIds: commaSeparatedList(env['ENTHUSIA_DISCORD_STAFF_ROLES']),
    defaultVisibilityCeiling: Visibility.PUBLIC,
    perUserRateLimit: {
      maxRequests: envInt(env['ENTHUSIA_DISCORD_PER_USER_LIMIT'], 5),
      windowMs: envInt(env['ENTHUSIA_DISCORD_PER_USER_WINDOW_MS'], 60_000),
    },
    globalRateLimit: {
      maxRequests: envInt(env['ENTHUSIA_DISCORD_GLOBAL_LIMIT'], 60),
      windowMs: envInt(env['ENTHUSIA_DISCORD_GLOBAL_WINDOW_MS'], 60_000),
    },
    maxMessageChars: 2000,
    maxChunksPerResponse: 10,
    ...(env['ENTHUSIA_DISCORD_SLASH_GUILD_ID']?.trim()
      ? { slashCommandGuildId: env['ENTHUSIA_DISCORD_SLASH_GUILD_ID']!.trim() }
      : {}),
  };
}
