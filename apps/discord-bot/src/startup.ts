/**
 * @enthusia/discord-bot — deployment entrypoint (W06).
 *
 * Wires the bot from the environment for production deployment:
 *
 *   1. `loadConfig()` from `@enthusia/config` (validates non-secret settings;
 *      `redactedConfig()` proves the token value is never logged);
 *   2. `resolveDiscordBotOptions(env)` for W06-owned settings;
 *   3. the bot token comes from `config.discordBotToken` (`DISCORD_BOT_TOKEN`
 *      env) — it is passed explicitly to the discord.js adapter and never
 *      enters a ChatRequest, a log line, or the zod config surface beyond
 *      the secret-marked field (Master Specification §5.5, §17.6).
 *
 * Nothing here runs on import. The deployment (W21) calls `startBotFromEnv()`.
 * Tests never call this module — they drive `EnthusiaAiDiscordBot` with mocks.
 */
import { loadConfig, redactedConfig } from '@enthusia/config';
import { createLogger } from '@enthusia/logging';

import { EnthusiaAiDiscordBot } from './bot.js';
import { resolveDiscordBotOptions, type DiscordBotOptions } from './config.js';
import { DiscordJsClientAdapter } from './discord-js-client.js';
import { createGatewayClient } from './gateway-client.js';

export interface StartedBot {
  bot: EnthusiaAiDiscordBot;
  options: DiscordBotOptions;
  stop: () => Promise<void>;
}

/**
 * Start the Discord bot from the process environment.
 * Throws when `DISCORD_BOT_TOKEN` is missing — the bot must never start
 * without credentials, and must never fall back to a placeholder.
 */
export async function startBotFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<StartedBot> {
  const config = loadConfig(env);
  const token = config.discordBotToken;
  if (!token) {
    throw new Error(
      'DISCORD_BOT_TOKEN is not set. Set it in the deployment environment ' +
        '(never commit it); see .env.example for the placeholder.',
    );
  }
  const options = resolveDiscordBotOptions(env);
  if (config.nodeEnv === 'production' && options.useMockGateway) {
    throw new Error('ENTHUSIA_DISCORD_USE_MOCK_GATEWAY must be false in production.');
  }
  if (config.nodeEnv === 'production' && !options.gatewayApiKey) {
    throw new Error(
      'ENTHUSIA_AI_GATEWAY_API_KEY is required in production so the Discord bot can authenticate to the AI Gateway.',
    );
  }
  const logger = createLogger({ name: 'discord-bot', level: config.logLevel });
  logger.info(redactedConfig(config), 'loaded configuration (secrets redacted)');

  const gateway = createGatewayClient(options, logger);
  const port = new DiscordJsClientAdapter(
    { token, ...(options.slashCommandGuildId ? { slashCommandGuildId: options.slashCommandGuildId } : {}) },
    logger,
  );
  const bot = new EnthusiaAiDiscordBot(port, gateway, options, logger);
  await bot.start();
  return { bot, options, stop: () => bot.stop() };
}
