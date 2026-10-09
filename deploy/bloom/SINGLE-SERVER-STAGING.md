# One Bloom panel server — staging launcher (2026-10-08)

**Status:** Staging code and local tests ONLY. **Not a complete Pterodactyl egg, not installed on Bloom, and no live SMP/SFTP connection.** See [issue #119](https://github.com/wsg138/Enthusia-AI/issues/119) and draft PR #118.

The owner-preferred target is **one Bloom Pterodactyl server/container** managing Enthusia AI. The original W21 egg in `deploy/bloom/egg.json` is an older **one-role-per-Pterodactyl-server** prepare-only template. It is not the preferred final topology and is not deployable as-is: the `discord` and `indexer` role paths intentionally exit.

## Implemented now

- `deploy/bloom/single-server-staging.mjs` supervises **Agent → Gateway → optionally the isolated Discord test bot** in one process tree.
- Guardrails: `NODE_ENV=development` and `ENTHUSIA_BLOOM_STAGING=1` required; Node 24 required; distinct localhost ports; no private integration configuration; no SFTP, Ticket Bot, moderation or memory tools; test Discord guild/channel specifically restricted; no production channel.
- Only explicit environment variables are passed to children. Agent/Gateway authentication keys are generated at runtime, remain in process memory, and are not logged.
- It waits for each service's `/health/ready`, refuses to attach to already occupied ports, handles SIGINT/SIGTERM, and tears down children on unexpected exit or startup failure. The real inference endpoint is currently **external to this process tree but must be localhost**.
- `--dry-run` validates configuration and never starts services; `--smoke` starts only Agent and Gateway, waits for readiness, then shuts them down (no Discord login).
- `deploy/bloom/check-single-staging.mjs` runs a credential-free local smoke with **ephemeral localhost ports** and the existing local Ollama Qwen3:8b, if it is available.
- `tests/integration/bloom-single-staging.test.ts` checks isolated staging opt-in, blocking production/private tools/remote inference, forbidden ticket-logs, port collisions, absent Discord auth, and smoke permission boundaries.

## Local test evidence

On the owner's Windows Node 24.12.0 test checkout:
- Guardrail suite **9/9 passed** (no network/credentials).
- Real supervised Agent+Gateway **ready and stopped cleanly** on unused localhost ports.
- No Discord credentials read or login attempted during the smoke; no SMP/Bloom/SFTP operations.

This proves a **supervisor foundation**, not Bloom deployment readiness or complete five-service cohosting.

## Missing before one Bloom server is feasible

1. **Model runs in the same container:** package/build a verified inference binary + model artifact, or another tested local model server; the Windows Qwen3 Ollama installation is **not** part of the Bloom container. Replace the temporary external-localhost inference dependency with a supervised inference child. Budget CPU/RAM and measure SMP impact.
2. **Durable indexer process:** wire W08 GitHub ingestion + W04 provenance + W07 retrieval to a persistent, bounded local index process and Agent typed read tool. The current W07 hashing embeddings are *test-only*. Use tested production embeddings.
3. **Container image and Pterodactyl egg:** select a reproducible and supported **Node 24 + model runtime** image. The public [Pterodactyl generic Node egg](https://github.com/pterodactyl/generic-eggs/blob/main/nodejs/egg-node-js-generic.json) lists `ghcr.io/ptero-eggs/yolks:nodejs_24`, but the host's ability to pull/use the image and its suitability for model inference still require verification. Don't assume old `ghcr.io/pterodactyl/yolks:nodejs_22` supports this launcher. Image must be reviewed and pinned to a digest before production.
4. **Persistent storage and lifecycle:** select server RAM/CPU/disk allocation, model and index volumes, log rotation, readiness, graceful restart/rollback and start-after-SMP policy. The one-container service supervisor must not take down unrelated Minecraft/Ticket/DiscordSRV services.
5. **Live read-only SFTP:** the code already exists in `integrations/sftp` and optional Agent wiring supports it, but it is **off** here. After Bloom staging review/approval, create a dedicated *OS-permission-enforced* read-only SFTP identity, pin the host key, review named source allowlists, inject runtime secrets privately, and run a tiny read-only smoke. Follow `integrations/sftp/LIVE-SOURCE-SETUP.md`.
6. **Actual server health:** SFTP does not prove current TPS, MSPT, host CPU/network or why lag occurs. Connect an separately approved, timestamped, restricted metrics interface under issue #41.

## No-credential local verification

From the repository root with installed npm dependencies and built TypeScript workspaces:

```sh
node deploy/bloom/check-single-staging.mjs
node ./node_modules/vitest/vitest.mjs run tests/integration/bloom-single-staging.test.ts
```

**No Docker/panel provisioning is done by these commands.** Do not run `--with-discord` while the existing Windows test bot is online; simultaneous login with the same Discord application/token can cause duplicate listeners. Never paste or commit a bot token.

## Authorization gates

Do not create a Bloom server, change its egg/image, start inference on the live shared host, grant SFTP or production access, or migrate the bot until the owner separately approves the rollout and available host capacity is verified. No urgency to reset or copy the existing bot token into chat.

