/**
 * @enthusia/discord-bot — bot orchestration (W06).
 *
 * The bot is a THIN surface (Master Specification §7, §6.1): it
 *
 *   1. decides whether an incoming Discord event is a trigger (policy.ts),
 *   2. enforces rate limits (§18.4),
 *   3. extracts actor context (context.ts),
 *   4. builds a ChatRequest (§48.1) with a fresh trace ID (§36),
 *   5. hands it to the AI Gateway client,
 *   6. formats the AgentResponse for Discord (formatting.ts) and sends it.
 *
 * It MUST NOT do reasoning, memory writes, GitHub search, or ticket state
 * transitions — those belong to W12 / W05 / W08 / W14. Error fallbacks are
 * generic and visibility-safe: internal detail goes to structured logs with
 * the trace ID, never to the user (spec §33, §17).
 */
import {
  EnthusiaError,
  chatRequestSchema,
  newTraceId,
  type AgentResponse,
  type ChatRequest,
} from '@enthusia/contracts';
import type { EnthusiaLogger } from '@enthusia/logging';

import type { DiscordBotOptions } from './config.js';
import { extractMessageContext, extractSlashAskContext } from './context.js';
import { formatAgentResponse } from './formatting.js';
import { formatRichAgentResponse } from './rich-formatting.js';
import type { AiGatewayClient } from './gateway-client.js';
import { decideSlashTrigger, decideTrigger, type TriggerDecision } from './policy.js';
import { DiscordRateLimitPolicy } from './rate-limit.js';
import type {
  DiscordClientPort,
  DiscordMessageRef,
  DiscordRichResponse,
  DiscordSlashAskRef,
  Snowflake,
} from './types.js';

/** Outcome of handling one event, for logs and tests. */
export type HandleOutcome =
  | 'responded'
  | 'ignored'
  | 'rate-limited'
  | 'greeted'
  | 'gateway-error';

export interface HandleResult {
  outcome: HandleOutcome;
  /** Trace ID for the request, when one was created. */
  traceId?: string;
  /** Policy reason when ignored. */
  reason?: string;
}

const FALLBACK_GATEWAY_ERROR =
  'Sorry — I could not reach the AI right now. Please try again in a moment.';
const FALLBACK_UNEXPECTED_ERROR =
  'Sorry — something went wrong on my end. Please try again in a moment.';

function greetingFor(displayName: string | undefined, botName: string): string {
  const who = displayName ? ` ${displayName}` : '';
  return (
    `Hi${who}! I'm ${botName}. ` +
    `Mention me or use \`/ai ask <question>\` and I'll do my best to help.`
  );
}

export class EnthusiaAiDiscordBot {
  private readonly rateLimits: DiscordRateLimitPolicy;
  private started = false;

  constructor(
    private readonly port: DiscordClientPort,
    private readonly gateway: AiGatewayClient,
    private readonly options: DiscordBotOptions,
    private readonly logger: EnthusiaLogger,
  ) {
    this.rateLimits = new DiscordRateLimitPolicy(
      options.perUserRateLimit,
      options.globalRateLimit,
    );
  }

  /** Connect, register slash commands, and wire event handlers. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.port.login();
    await this.port.registerSlashCommands();
    this.port.onMessage((message) => {
      void this.handleMessage(message).catch((error: unknown) => {
        this.logger.error({ error: String(error) }, 'unhandled error in message handler');
      });
    });
    this.port.onSlashAsk((interaction) => {
      void this.handleSlashAsk(interaction).catch((error: unknown) => {
        this.logger.error({ error: String(error) }, 'unhandled error in slash handler');
      });
    });
    this.started = true;
    this.logger.info(
      {
        botUserId: this.port.botUserId,
        mockGateway: this.options.useMockGateway,
        testChannels: this.options.testChannelIds.length,
        aiChannels: this.options.aiChannelIds.length,
      },
      'Enthusia AI Discord bot started',
    );
  }

  async stop(): Promise<void> {
    await this.port.destroy();
    this.started = false;
  }

  /** Full pipeline for an incoming message. Exposed for tests. */
  async handleMessage(message: DiscordMessageRef): Promise<HandleResult> {
    if (this.options.slashOnly) {
      return { outcome: 'ignored', reason: 'slash-command-only test mode' };
    }
    if (!this.inAllowedScope(message.channel.guild?.id, message.channel.id)) {
      return { outcome: 'ignored', reason: 'outside allowed test guild/channel' };
    }
    const decision = decideTrigger(message, this.port.botUserId, this.options);
    const trigger = decision.trigger;
    if (trigger === null || (this.options.mentionOnly && trigger !== 'mention')) {
      this.logger.debug({ reason: decision.reason, messageId: message.id }, 'message ignored');
      return { outcome: 'ignored', reason: decision.reason };
    }
    // The original message gets best-effort status reactions. A failed
    // reaction (missing permission, deleted message) must never block Q&A.
    await this.tryReaction(message, '👀', true);
    let result: HandleResult | undefined;
    try {
      result = await this.respondToTrigger(
        decision,
        message.author.id,
        message.author.displayName ?? message.author.username,
        () => extractMessageContext(message, trigger, this.options),
        (chunks) =>
          this.port.sendMessage(message.channel.id, {
            content: chunks[0] as string,
            replyToMessageId: message.id,
          }).then(() => this.sendRemainingChunks(message.channel.id, chunks.slice(1))),
        {
          ...(this.port.sendRichMessage ? {
            sendRich: (card: DiscordRichResponse) =>
              this.port.sendRichMessage!(message.channel.id, card, message.id),
          } : {}),
          onGatewayStart: async () => {
            await this.tryReaction(message, '👀', false);
            await this.tryReaction(message, '🤔', true);
          },
        },
      );
      return result;
    } finally {
      await this.tryReaction(message, '👀', false);
      await this.tryReaction(message, '🤔', false);
      await this.tryReaction(message,
        result?.outcome === 'responded' || result?.outcome === 'greeted' ? '✅' : '❌', true);
    }
  }

  /** Full pipeline for a `/ai ask` invocation. Exposed for tests. */
  async handleSlashAsk(interaction: DiscordSlashAskRef): Promise<HandleResult> {
    if (!this.inAllowedScope(interaction.channel.guild?.id, interaction.channel.id)) {
      return { outcome: 'ignored', reason: 'outside allowed test guild/channel' };
    }
    // Acknowledge only authorized slash interactions before slow inference.
    await this.port.deferSlashAsk?.(interaction);
    const decision = decideSlashTrigger(interaction.question);
    return this.respondToTrigger(
      decision,
      interaction.user.id,
      interaction.user.displayName ?? interaction.user.username,
      () => extractSlashAskContext(interaction, this.options),
      (chunks) => this.port.respondToSlashAsk(interaction, chunks),
      {
        ...(this.port.respondToSlashAskRich ? {
          sendRich: (card: DiscordRichResponse) => this.port.respondToSlashAskRich!(interaction, card),
        } : {}),
      },
    );
  }

  private inAllowedScope(guildId: string | undefined, channelId: string): boolean {
    const allowedGuilds = this.options.allowedGuildIds;
    if (allowedGuilds.length > 0 && (guildId === undefined || !allowedGuilds.includes(guildId))) {
      return false;
    }
    const channels = this.options.allowedChannelIds;
    if (channels.length > 0 && !channels.includes(channelId)) return false;
    return true;
  }

  /**
   * Shared pipeline after the trigger is known. `sendChunks` delivers the
   * formatted response through the surface that triggered it.
   */
  private async respondToTrigger(
    decision: TriggerDecision,
    userId: Snowflake,
    displayName: string | undefined,
    extractContext: () => ReturnType<typeof extractMessageContext>,
    sendChunks: (chunks: string[]) => Promise<unknown>,
    rich?: {
      sendRich?: (card: DiscordRichResponse) => Promise<unknown>;
      onGatewayStart?: () => Promise<void>;
    },
  ): Promise<HandleResult> {
    const traceId = newTraceId();
    const log = this.logger.withTraceId(traceId);

    // 1. Rate limits (§18.4) — checked before any gateway work.
    const limit = this.rateLimits.check(userId);
    if (!limit.allowed) {
      const waitSec = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
      log.warn({ userId, deniedBy: limit.deniedBy }, 'rate limit hit');
      await sendChunks([
        `You're asking a bit too fast — please wait about ${waitSec} second${waitSec === 1 ? '' : 's'} and try again.`,
      ]);
      return { outcome: 'rate-limited', traceId };
    }

    // 2. Bare mention with no question → greeting, no gateway call.
    if (decision.prompt === '') {
      log.debug({ userId, trigger: decision.trigger }, 'bare mention, sending greeting');
      await sendChunks([greetingFor(displayName, this.options.botName)]);
      return { outcome: 'greeted', traceId };
    }

    // 3. Actor context + ChatRequest (§48.1).
    const { actor, visibilityCeiling, context, conversationId } = extractContext();
    const request: ChatRequest = {
      surface: 'discord',
      actor,
      conversationId,
      message: decision.prompt,
      context: { ...context, botName: this.options.botName },
      visibilityCeiling,
      traceId,
    };
    try {
      chatRequestSchema.parse(request);
    } catch (error) {
      log.error({ error: String(error) }, 'built an invalid ChatRequest — refusing to send');
      await sendChunks([FALLBACK_UNEXPECTED_ERROR]);
      return { outcome: 'gateway-error', traceId };
    }

    // 4. Gateway round-trip.
    await rich?.onGatewayStart?.();
    let response: AgentResponse;
    try {
      log.info(
        { userId, trigger: decision.trigger, conversationId, visibilityCeiling },
        'dispatching ChatRequest to AI Gateway',
      );
      response = await this.gateway.sendChat(request);
    } catch (error) {
      return this.handleGatewayError(error, traceId, log, sendChunks);
    }

    // 5. Format + send (§18 response formatting).
    const chunks = formatAgentResponse(
      response,
      this.options.maxMessageChars,
      this.options.maxChunksPerResponse,
    );
    log.info(
      { userId, chunks: chunks.length, responseTraceId: response.traceId },
      'sending AgentResponse to Discord',
    );
    const card = rich?.sendRich ? formatRichAgentResponse(response) : null;
    if (card && rich?.sendRich) {
      try {
        await rich.sendRich(card);
      } catch {
        // Lack of Embed Links permission or an unsupported Discord surface
        // must not prevent a valid, already-verified answer.
        log.warn('rich response unavailable; falling back to plain text');
        await sendChunks(chunks);
      }
    } else {
      await sendChunks(chunks);
    }
    return { outcome: 'responded', traceId };
  }

  private async tryReaction(message: DiscordMessageRef, emoji: string, add: boolean): Promise<void> {
    try {
      if (add) await this.port.addMessageReaction?.(message, emoji);
      else await this.port.removeMessageReaction?.(message, emoji);
    } catch {
      this.logger.debug({ messageId: message.id, emoji }, 'message status reaction unavailable');
    }
  }

  private async sendRemainingChunks(channelId: Snowflake, chunks: string[]): Promise<void> {
    for (const chunk of chunks) {
      await this.port.sendMessage(channelId, { content: chunk });
    }
  }

  private async handleGatewayError(
    error: unknown,
    traceId: string,
    log: EnthusiaLogger,
    sendChunks: (chunks: string[]) => Promise<unknown>,
  ): Promise<HandleResult> {
    if (error instanceof EnthusiaError) {
      // EnthusiaError messages are visibility-safe by contract.
      log.error(
        { code: error.code, statusCode: error.statusCode },
        `AI Gateway error: ${error.message}`,
      );
      const notice = error.code === 'TOOL_TIMEOUT'
        ? 'That took longer than expected. Please try again in a moment.'
        : error.code === 'RATE_LIMITED'
          ? 'The AI is handling too many requests right now. Please wait a moment and try again.'
          : FALLBACK_GATEWAY_ERROR;
      await sendChunks([notice]);
    } else {
      log.error({ error: String(error) }, 'unexpected error calling AI Gateway');
      await sendChunks([FALLBACK_UNEXPECTED_ERROR]);
    }
    return { outcome: 'gateway-error', traceId };
  }
}
