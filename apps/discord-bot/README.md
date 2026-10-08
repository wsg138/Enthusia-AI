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

## Owner test Discord local launch (Qwen3 8B)

Owner-verified **test guild** (not the real server): \`1552729865306767471\`.
The \`ticket-logs\` channel is prohibited for AI testing. On the owner's PC,
\`C:\Users\racec\Blackboard\Enthusia-AI-Training\local-ai-preflight\Start-EnthusiaAi-Test.ps1\`
sets up a clean separate test working copy, builds the mono-repo, and launches
\`deploy/local/discord-test-runner.mjs\` without persisting credentials.

**Only from the private PowerShell process where the token was entered:**
\`\`\`powershell
& "$env:USERPROFILE\Blackboard\Enthusia-AI-Training\local-ai-preflight\Start-EnthusiaAi-Test.ps1"
\`\`\`

The launcher prompts for the numeric \`#ai-testing\` Discord channel ID; it
refuses the known \`ticket-logs\` channel ID. It scopes *all* response triggers,
including mentions and \`/ai ask\`, to that guild and one channel. This is
separate from \`ENTHUSIA_DISCORD_TEST_CHANNELS\` (which auto-triggers on every
message); the launcher keeps that auto-trigger list EMPTY. Use slash commands
to test. The bot will ignore triggers elsewhere; slash commands outside the
allowed test channel may show Discord's generic "application did not respond"
status because no reply is intentionally sent there.

The launcher uses preinstalled local Ollama \`qwen3:8b\` with
\`ENTHUSIA_INFERENCE_THINKING_MODE=disabled\`, ephemeral internal bearer keys,
and NO live Ticket Bot/SFTP/moderation/OpenAI credentials. Gateway and agent
run at local \`127.0.0.1:4100\` and \`127.0.0.1:4200\` URLs respectively, with
authenticated requests even in development; the existing Node services'
listener ports are not otherwise publicly authorized. The launcher refuses
those ports when already occupied and stops only its own children on exit.
It does not train, rent GPUs, create users, close tickets, or change Bloom.
Only use it on a trusted Windows PC; other machines on the LAN should not be
given internal service bearer keys. No test conversations should include
secrets or actual private tickets.

**Normal production** remains gated by separate deploy review. This test
helper deliberately reuses an existing Discord application already installed
in the test guild. The bot token is never passed on the command line or
checked into source. Running two Discord gateway processes with the same bot
token concurrently is unsupported.

**Important:** This local preflight does not imply that the full AI
reasoner reliably produces strict JSON from Qwen3 8B. Record actual test
results and errors before considering broader bot access or training.
