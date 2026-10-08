# @enthusia/discord-bot — Enthusia AI Discord adapter (W06)

Thin Discord surface for Enthusia AI. It owns the Discord mechanics —
login, mentions, the `/ai ask` slash command, configured channels, actor
context, response formatting, and rate limits — and hands every question to
the AI Gateway (W02) as a `ChatRequest`. It does **not** do reasoning,
memory, GitHub search, or ticket state (W12 / W05 / W08 / W14).

Spec: `MASTER-SPECIFICATION.md` §6.1, §18, §36. Plan: `WORKER-EXECUTION-PLAN.md` §9.

## Trigger policy (strict)

The bot responds ONLY to:

1. an explicit `@mention` of the bot,
2. the `/ai ask <question>` slash command,
3. messages in a configured test channel (`ENTHUSIA_DISCORD_TEST_CHANNELS`),
4. messages in a configured AI channel (`ENTHUSIA_DISCORD_AI_CHANNELS`, §18.1).

Everything else is ignored. Bots (including itself) are never answered.

## Layout

| File | Responsibility |
|---|---|
| `src/types.ts` | `DiscordClientPort` + normalized Discord shapes (no discord.js) |
| `src/policy.ts` | trigger decisions, mention stripping |
| `src/context.ts` | actor identity, role mapping, join-time context, visibility ceiling |
| `src/formatting.ts` | Discord-safe markdown, 2000-char chunking, mass-mention neutralization |
| `src/rate-limit.ts` | per-user + global token buckets (§18.4) |
| `src/gateway-client.ts` | `HttpAiGatewayClient` (W02) and `MockAiGatewayClient` (until W02 lands) |
| `src/bot.ts` | orchestration: trigger → rate limit → context → ChatRequest → format → send |
| `src/discord-js-client.ts` | real discord.js adapter (only module importing discord.js) |
| `src/health.ts` | §36 health report builder |
| `src/startup.ts` | deployment entrypoint (`startBotFromEnv`) |
| `test/` | unit + integration tests, all against a mock port — no live Discord |

## Secrets

The bot token comes from `DISCORD_BOT_TOKEN` via `@enthusia/config`'s
`loadConfig().discordBotToken` and is passed explicitly to the discord.js
adapter. It never enters a `ChatRequest`, a log line, or the zod config
surface beyond the secret-marked field (§5.5, §17.6). Channel/role IDs are
configuration, not secrets — see `.env.example`.

## Running tests

From the repo root: `npx vitest run apps/discord-bot/test/`

## Safe slash registration and shared application warning

The bot registers `/ai ask` with a **single-command upsert** instead of
bulk-overwriting every slash command for the same application. This preserves
Ticket Bot commands if an owner later integrates both surfaces under one
Discord application identity. It does **not** make running two independent
Gateway clients with a shared Discord bot token safe: interaction ownership,
replies, sharding, rate limits, token exposure and permissions must be
coordinated in a single bot runtime or an explicitly tested integration.

Recommended initial testing: retain the existing Ticket Bot for ticket
lifecycle; create a separate Enthusia AI Discord application and use that
**same Enthusia AI application** in the testing guild and later the actual
Enthusia guild. Keep credentials separate. Existing test guild
`ENTHUSIA_DISCORD_SLASH_GUILD_ID` should be used for fast test-only registration;
leave all auto-response channel ID lists empty until a dedicated AI test
channel is approved. The bot currently requests privileged Member and
Message Content gateway intents; both must be enabled in the Developer Portal
for the chosen application. Production deployment is independent of a merge.
