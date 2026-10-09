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


## 2026-10-08 19:58 EDT: Warzones mention returned ❌ and generic gateway error

Owner's screenshot from the isolated #ai-testing channel:
- Input: \`@Enthusia AI Can you explain how the warzones combat rotator system works\`.
- Expected mention handling occurred (the bot replied to the exact Discord message, original message received ❌).
- Actual reply: \`Sorry — I could not reach the AI right now. Please try again in a moment.\`.
- The screenshot alone does **not** establish whether it was a timeout, rate-limit HTTP response, or a transport error. The previous user-facing fallback grouped multiple conditions into the same message. This was a Gateway request failure, not proof the @mention listener was broken.

Investigation:
- In the isolated launcher, downstream Gateway → Agent had \`ENTHUSIA_GATEWAY_AGENT_TIMEOUT_MS=120000\`, while Discord → Gateway still used its default \`30000\` ms. A slow Qwen3 inference can exceed Discord's deadline even when the Gateway/Agent could return normally.
- Reproduced the **same Warzones question** with a credential-free loopback Agent + Gateway request using \`node deploy/local/check-local-chat-smoke.mjs --warzone\`: **HTTP 200 in 20,641 ms**, response: \`I could not verify how does the warzones combat rotator system work from current sources.\`. This demonstrates that the source-less Agent can give an appropriate non-hallucinated answer. It does NOT prove the owner's screenshot was specifically a timeout because live error logs weren't supplied.
- Fix: isolated launcher explicitly sets \`ENTHUSIA_DISCORD_GATEWAY_TIMEOUT_MS=130000\`, longer than the Gateway's 120-second Agent deadline. Existing production defaults are unchanged.
- Fix: HTTP client preserves HTTP 429 as \`RATE_LIMITED\` and HTTP 504 as \`TOOL_TIMEOUT\`; log safe upstream HTTP status/trace metadata, not model or user-provided content. Discord now provides distinct short messages for timeout and rate limit; genuine network failures retain a generic reachability error.
- Tests: **1,132 passing, one preexisting integration smoke skipped**, clean Discord TypeScript build, targeted lint clean. Test checkout fast-forwarded cleanly on owner's PC; no token needed, no bot session stopped or restarted. Draft PR #118 remains HOLD.

Owner acceptance: Stop the existing isolated launcher with Ctrl+C, rerun it (same existing token entered in private prompt), and mention the AI in #ai-testing asking the **same Warzones question**. The answer should be a short, source-limited reply instead of a Gateway error; if it still fails, share the **non-secret** console errors including any \`gatewayStatus\`, \`code\`, \`statusCode\`, and elapsed time. Avoid copy/pasting tokens. Current pilot only indexes PieCloak's public README; it **cannot yet verify** the actual Warzones combat rotator behavior. The absence of Warzones source knowledge is a separate planned integration, not a reason for the Discord transport to fail.


## 2026-10-08 20:18 EDT: returned Agent fallback mislabelled as successful

Owner's third screenshot:
- The @mention was accepted and a response was posted as a Discord embed.
- The Agent replied "I could not finish that request. Please try again in a moment."
- The message showed a ✅ reaction even though the result was an internal **Agent** failure. The prior bot chose ✅ based only on HTTP success and the embed being delivered. This is a known protocol issue, independent of the previously fixed Gateway timeout.
- Do **not** infer from the screenshot whether Qwen's classification failed, was malformed, timed out, or something else; no contemporaneous Agent error category was shared.

### Fixes (isolated test branch; no production deployment)

1. The shared AgentResponse API contract now has a backward-compatible optional outcome: answered, unverified, error. The Agent explicitly marks internal exceptions as error and no-evidence results as unverified; the validated public-docs pilots return answered or unverified. The Gateway and Discord HTTP adapter carry this signal end-to-end.
2. An answered @mention receives ✅, missing-source result receives ⚠️, and an internal Agent error receives ❌. Embed colors/headlines match. 200 OK by itself **never proves the underlying question was answered**.
3. Located the public Warzones Rotator documentation in **wsg138/MaceGuard/README.md**. Added the same narrow allowlisted read-only pilot used for PieCloak, now pointed at exactly the MaceGuard repository and its main-branch README. It verifies public repo visibility, exact main commit, Git blob SHA, document-size bounds, and required gameplay sections. It cannot browse arbitrary repos, use credentials, consult private server data, or claim live active modifiers. It replies with a short bullet-point summary of kit/modifier rotation, player combat rules, manual overrides and public commands. The source link is a named embed hyperlink, not a bare URL preview. This remains a *pilot*, not the generalized W07/W08 knowledge system.
4. The doc source used for test: https://github.com/wsg138/MaceGuard/blob/38e4255cf1940c2397da5a4e2cecc6c56498c8b4/README.md (pinned public GitHub HEAD during this local test, not proof of deployed plugin).
5. The run with the original Warzones question through localhost Agent + Gateway now produced an evidence-backed answer with **HTTP 200 in 483 ms** and explicit outcome=answered. No Discord token was used. Latest Vitest **1,142 passed, 1 preexisting smoke skipped**. Discord/Agent TypeScript checks and targeted lint passed; the isolated Windows checkout is clean and current.

### Owner acceptance

Stop the already-running test PowerShell with Ctrl+C and relaunch the existing Start-EnthusiaAi-Test.ps1, privately entering the same token. Mention the bot in the approved #ai-testing channel:

- "@Enthusia AI Can you explain how the Warzones combat rotator system works?"

Expected result is a **short orange Warzones embed**, bullets for rotation/combat rules/overrides, named source link to the pinned MaceGuard README, and the final ✅ reaction.

For follow-up validation of error honesty, use the bot's existing source-limited capabilities on an unrelated server-specific question; if source proof is missing, it should show a safe unverified message and ⚠️, not ✅. Do not intentionally break production services or share credentials to exercise errors.

Draft PR #118 remains HOLD pending owner-confirmed Discord result and independent reviews. No production services/configs, ticket tools, staff permissions or saved tokens changed.
