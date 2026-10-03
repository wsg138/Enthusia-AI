/**
 * @enthusia/discord-bot — response trigger policy (W06).
 *
 * Initial behavior is STRICT (WORKER-EXECUTION-PLAN §9, "W06 — Discord
 * adapter"): the bot responds ONLY to
 *
 *   1. an explicit @mention of the bot,
 *   2. the `/ai ask` slash command (handled separately, always a trigger),
 *   3. a message in a configured test channel,
 *   4. a message in a configured AI channel (§18.1 lists "configured AI
 *      channel" as an initial trigger; the spec wins over the workstream
 *      brief where they differ).
 *
 * The bot MUST NOT begin broad automatic message interception: any other
 * message is ignored, and this module is the single choke point that
 * decides. Bots (including itself) are never answered.
 */
import type { DiscordBotOptions } from './config.js';
import type { DiscordMessageRef, Snowflake } from './types.js';

/** Why the bot decided to respond (or not). */
export type TriggerKind = 'mention' | 'slash' | 'ai-channel' | 'test-channel';

/** The policy decision for one incoming message. */
export interface TriggerDecision {
  /** Null when the message must be ignored. */
  trigger: TriggerKind | null;
  /** Human-readable reason, for logs and tests. */
  reason: string;
  /**
   * The prompt text forwarded to the AI Gateway: the message with any
   * leading/trailing bot-mention markup stripped.
   */
  prompt: string;
}

/** `<@123…>` or `<@!123…>` mention markup for a user ID. */
const mentionPattern = (botUserId: Snowflake): RegExp =>
  new RegExp(`<@!?${botUserId}>`, 'g');

/**
 * Strip bot-mention markup from the message and collapse whitespace.
 * A bare mention with no other text yields an empty prompt; the bot core
 * answers those with a greeting instead of calling the gateway.
 */
export function extractPrompt(content: string, botUserId: Snowflake): string {
  return content.replace(mentionPattern(botUserId), ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Decide whether an incoming message triggers a response.
 *
 * `botUserId` may be null before login/ready; in that state mentions cannot
 * be detected, so only configured-channel messages trigger.
 */
export function decideTrigger(
  message: DiscordMessageRef,
  botUserId: Snowflake | null,
  options: DiscordBotOptions,
): TriggerDecision {
  if (message.author.isBot) {
    return { trigger: null, reason: 'author is a bot', prompt: '' };
  }
  if (botUserId !== null && message.author.id === botUserId) {
    return { trigger: null, reason: 'author is the bot itself', prompt: '' };
  }

  const mentioned =
    botUserId !== null && message.mentionedUserIds.includes(botUserId);
  if (mentioned) {
    return {
      trigger: 'mention',
      reason: 'explicit bot mention',
      prompt: extractPrompt(message.content, botUserId as Snowflake),
    };
  }

  const channelId = message.channel.id;
  if (options.testChannelIds.includes(channelId)) {
    return {
      trigger: 'test-channel',
      reason: 'message in configured test channel',
      prompt: message.content.trim(),
    };
  }
  if (options.aiChannelIds.includes(channelId)) {
    return {
      trigger: 'ai-channel',
      reason: 'message in configured AI channel',
      prompt: message.content.trim(),
    };
  }

  return { trigger: null, reason: 'no trigger: not a mention or configured channel', prompt: '' };
}

/** Slash commands are always an explicit trigger (§18.1). */
export function decideSlashTrigger(question: string): TriggerDecision {
  return {
    trigger: 'slash',
    reason: '/ai ask slash command',
    prompt: question.trim(),
  };
}
