# Isolated Discord UX: embeds and @mention replies

Status: **implemented and locally validated; owner Discord retest pending**.
Branch: `fix/discord-command-safe-upsert-20261008` / draft PR #118. No production merge/deployment.

## Changes

1. `/ai ask` and accepted `@Enthusia AI <question>` requests now prefer a single compact native Discord embed instead of a dense plain-text paragraph. Replies with code fences/large output retain the tested legacy text-chunk path. Arbitrary model assertions are **not** promoted to verified sources.
2. The public PieCloak pilot gives an easier player explanation with three distance bullets and a clear documentation-versus-live-server caveat. The embed has two compact Markdown hyperlinks, not a raw URL that makes a large GitHub preview:
   - [Official Enthusia Wiki](https://enthusia.miraheze.org/wiki/Main_Page) — **landing page only**. A specific public PieCloak wiki article URL could not be verified; do not invent a slug. When a verified article is located, replace the landing-page destination.
   - [GitHub README at exact verified commit](https://github.com/wsg138/PieCloak/blob/af92ee075ebdd7fbf95199f340a0dde04997dfc9/README.md) — technical evidence, displayed as a short named hyperlink.
3. Mention requests on the allowed test channel receive best-effort reactions **👀 → 🤔 → ✅**. The initial eyes reaction is attached only after guild/channel/trigger guards. The thinking reaction begins as the Gateway dispatch starts; temporary reactions are removed after the response is sent. Errors show **❌** and do not claim staff action. Missing reaction permissions never block AI replies.
4. The isolated launcher now sets `ENTHUSIA_DISCORD_SLASH_ONLY=false` and `ENTHUSIA_DISCORD_MENTION_ONLY=true`. Only *actual Discord mentions* are accepted for ordinary messages, and only in the single approved `#ai-testing` channel of the isolated guild. Bare unmentioned messages still do **not** trigger the AI. Slash commands remain available. A Discord application mention receives the content even without the privileged Message Content intent, per [Discord Gateway documentation](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx#message-content-intent). This mode requests only Guilds + GuildMessages, not MessageContent or GuildMembers intents.
5. Outbound embeds use `allowedMentions: {parse:[]}` (and `repliedUser:false` on message replies) to prevent accidental pings. Raw @everyone/@here are also neutralized in readable content.

## Local test coverage

- Full repository Vitest: **1,127 passed, 1 preexisting inference smoke skipped** (2026-10-08).
- Test-only new regression cases: rich PieCloak embed and compact source links, malicious mass-mention removal, source-provenance guard, long-answer fallback, allowed guild and channel, non-mention ignored, reaction sequence, reaction-permission failure, failed Gateway → ❌, rich slash response. Discord TypeScript build and targeted ESLint clean.
- Real public GitHub README request (verified commit and blob), then loopback-only Agent/Gateway synthetic PieCloak request: both passed. **Real Discord embeds/reactions have NOT yet been owner-confirmed.**

## Owner acceptance test

1. Stop the currently running local Enthusia AI PowerShell launcher using **Ctrl+C**, then rerun:
   `& "$env:USERPROFILE\Blackboard\Enthusia-AI-Training\local-ai-preflight\Start-EnthusiaAi-Test.ps1"`
2. Enter the **existing** separate Enthusia AI bot token privately in the hidden prompt; do not paste credentials to GitHub or chat.
3. In the existing approved test guild's `#ai-testing` channel, run `/ai ask question: How does PieCloak work?`. Expected: colored compact embed with bullet-point explanation; no giant raw GitHub URL preview; named Wiki and Technical source links.
4. In the same channel, send **a normal message with an actual Discord bot mention**: `@Enthusia AI How does PieCloak work?`. Expected: a reply embed attached to that original message and reactions 👀 then 🤔 and, after reply, ✅ (temporary reactions removed).
5. Send a **normal message without a mention** in `#ai-testing`; expect no reply or reactions. Do not test in `ticket-logs` or production channels.
6. If embeds do not appear or reactions fail, check the bot permissions only in the approved test channel: View Channel, Send Messages, Embed Links, Add Reactions, and Read Message History. Do not give Administrator. Share nonsecret console errors for diagnosis.

Remaining HOLD gates: only this dedicated test app; no private tools/tickets; no broad message interception; no deployment, merge, or token reset; source-backed broader answers and direct PieCloak wiki article are separate milestones.
