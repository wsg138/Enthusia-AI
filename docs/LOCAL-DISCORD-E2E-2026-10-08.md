# Isolated Discord AI proof and verified-source next milestone — 2026-10-08

Status: **owner-confirmed Discord Q&A works in test guild; source-backed server answers not yet enabled.**
Do **not** represent this as production deployment or as connected server knowledge.

## Proof of completed test

Approved guild: `1552729865306767471` and the exact existing `#ai-testing` test channel only. Excluded ticket-logs: `1552873662745546822`. The dedicated Enthusia AI application was used, not the Ticket Bot/DiscordSRV application. Bot token stayed in a masked PowerShell prompt and process memory.

Owner-confirmed:
- `/ai ask question: What can you do?` returned:
  > I can help explain general topics and work through Enthusia questions. For current server information, player accounts, punishments, or tickets, I need connected, verified sources and will not guess without them.
- `/ai ask question: How does the pie cloak system work on the server?` returned:
  > I could not verify How does the pie cloak system work on the server from current sources.

This establishes that the bot connected through the isolated Discord slash command, Gateway, Agent, and locally running Qwen3. It does **not** establish that it has functioning retrieval, action tools, historical continuity, moderation permissions, or ticket knowledge. No tool or private source was connected in this test.

## First source-backed question: PieCloak

The authoritative public documentation is available in `wsg138/PieCloak`:
- [README](https://github.com/wsg138/PieCloak/blob/main/README.md) describes anti-ESP/entity and block-entity clue hiding, the visibility bands, exclusions, and player-facing limits.
- The repo currently describes **always-show 24 blocks**, **raycast up to 48 blocks**, **three occluding samples**, entity recheck 10 ticks, block-entity recheck 20 ticks, and `PacketEvents`. These are documented/config-intended rules, *not proof that the latest source was deployed*.
- Existing [Enthusia-AI deployment inventory](https://github.com/wsg138/Enthusia-AI/blob/main/docs/audits/live-plugin-intelligence/SMP-PLUGIN-INVENTORY.md) recorded `PieCloak-1.21.11-visibility-test.3-3084a56.jar` on 2026-10-05. Deployment identity and docs SHA differ; no later runtime sync has been independently checked.
- Existing [2026-10-05 read-only SMP audit](https://github.com/wsg138/Enthusia-AI/blob/main/docs/audits/live-plugin-intelligence/SMP-RUNTIME-HEALTH.md) observed a **DEGRADED** state (193 warnings; 166 post-spawn reconciliation expirations). Relevant defect: [wsg138/PieCloak#17](https://github.com/wsg138/PieCloak/issues/17). This is dated evidence, not a claim about today's runtime.

Expected safe answer **after** a real read-only source integration:
- Explain **documented intended behavior** of PieCloak in plain player terms, and cite the README and its observed commit/last-checked timestamp.
- Do not claim current production health or exact runtime settings without current deployment proof. When useful, say last observed runtime was degraded as of **2026-10-05**; explain limitation briefly without publishing raw logs or player identifiers.
- Refuse to invent game rules or expose private paths, settings, player histories, or staff-only data.
- If no *fresh approved public source* can be validated, remain on the current `could not verify` path rather than silently accepting Qwen model knowledge.

## Next implementation milestone — read-only public GitHub knowledge, not a new system

Existing components to compose rather than duplicate:
- `integrations/github/`: **W08** approved-repository GitHub indexer with source-SHA provenance and supersession.
- `services/knowledge-indexer/`: **W07** retrieval engine, default CURRENT-only filtering, explicit visibility ceiling, optional deployed-SHA filtering.
- `packages/source-provenance/`: registry with source history and invalidation.
- `apps/agent-service/src/runtime.ts`: authoritative `ToolRegistry` composition seam; **not** connected to the indexer for this smoke test.

Before implementation, reconcile [#41](https://github.com/wsg138/Enthusia-AI/issues/41) (typed plugin read tools), [#106](https://github.com/wsg138/Enthusia-AI/issues/106) (knowledge freshness; closed), and existing worker branches; respect code ownership.

### Safe sequence

1. Add an explicit **public-source allowlist** (`wsg138/PieCloak` first) and a read-only offline/synthetic fixture for tests. Do not load arbitrary repository files by model request.
2. Connect GitHub indexer → source-provenance registry → knowledge-indexer → a narrow `knowledge.search` tool with `Visibility.PUBLIC` and source-status checks. No token in messages, prompts, logs, repo, or persisted sample data.
3. Add source/deployed distinction: GitHub `main` documents intent, deployed git SHA proves live identity only if verified against the exact JAR (the October 5 inventory is historical). Keep status/date in response provenance and don't claim live correctness from a documentation HEAD.
4. Wire tool only behind a **test-only opt-in**; keep the no-live-tools smoke path intact. No unrestricted local filesystem/SFTP/DB tool, no Ticket Bot access, and no production write permission.
5. Run bounded tests for correct PieCloak answer with citation; stale source vs deployed SHA; withdrawn/renamed docs; conflicting sources; missing source; private/staff evidence ceiling; URL/token/path prompt injection; tool timeout; no hallucination; no cross-guild response.
6. Verify one real `/ai ask` response in approved test channel **with a citation and version/observed date**, then consider broadening the allowlist. Keep prod HOLD until separately authorized.

### Existing code-review blockers

Draft [PR #118](https://github.com/wsg138/Enthusia-AI/pull/118) remains an isolated local testing PR, not production-ready. Outstanding merge conflicts/review/quality-gate triage and the **three development-only npm audit advisories** remain separate. Keep any source wiring from changing production default behavior.
