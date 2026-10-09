# One Bloom panel server — staging launcher (2026-10-08)

**Status:** Staging code and local tests ONLY. **Not a complete Pterodactyl egg, not installed on Bloom, and no live SMP/SFTP connection.** See [issue #119](https://github.com/wsg138/Enthusia-AI/issues/119) and draft PR #118.

The owner-preferred target is **one Bloom Pterodactyl server/container** managing Enthusia AI. The original W21 egg in `deploy/bloom/egg.json` is an older **one-role-per-Pterodactyl-server** prepare-only template. It is not the preferred final topology and is not deployable as-is: the `discord` and `indexer` role paths intentionally exit.

## Implemented now

- `deploy/bloom/single-server-staging.mjs` supervises **Agent → Gateway → optionally the isolated Discord test bot** in one process tree.
- Guardrails: `NODE_ENV=development` and `ENTHUSIA_BLOOM_STAGING=1` required; Node 24 required; distinct localhost ports; no private integration configuration; no SFTP, Ticket Bot, moderation or memory tools; test Discord guild/channel specifically restricted; no production channel.
- Only explicit environment variables are passed to children. Agent/Gateway authentication keys are generated at runtime, remain in process memory, and are not logged.
- It waits for each service's `/health/ready`, refuses to attach to already occupied ports, handles SIGINT/SIGTERM, and tears down children on unexpected exit or startup failure. The inference endpoint must remain localhost. The new `--managed-inference` mode can supervise a SHA-256-verified `llama-server` binary and model in the same process tree; otherwise the launcher uses a pre-existing local endpoint.
- `--dry-run` validates configuration and never starts services; `--smoke` starts only Agent and Gateway, waits for readiness, then shuts them down (no Discord login).
- `deploy/bloom/check-single-staging.mjs` runs a credential-free local smoke with **ephemeral localhost ports** and the existing local Ollama Qwen3:8b, if it is available.
- `tests/integration/bloom-single-staging.test.ts` checks isolated staging opt-in, blocking production/private tools/remote inference, forbidden ticket-logs, port collisions, absent Discord auth, and smoke permission boundaries.

## Local test evidence

On the owner's Windows Node 24.12.0 test checkout:
- Original staging guardrail suite **10/10 passed** (no network/credentials).
- Real supervised Agent+Gateway **ready and stopped cleanly** on unused localhost ports.
- No Discord credentials read or login attempted during the smoke; no SMP/Bloom/SFTP operations.

This proves a **supervisor foundation**, not Bloom deployment readiness or complete five-service cohosting.

## Missing before one Bloom server is feasible

1. **Model packaging and real host proof:** the supervisor now supports a pinned `llama-server` child and validates checksums, API-key authentication, exact model identity, local binding, threads and shutdown. However no real GGUF/llama-server pair has been launched together on Bloom. A staging-only Dockerfile candidate exists, and model files must still be mounted and verified on the actual Linux host. Budget CPU/RAM and measure SMP impact.
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


## Managed inference implementation — 2026-10-08

The supervisor now also supports `--managed-inference` for a **single process tree**:

1. Validate the explicitly configured **absolute** `ENTHUSIA_MODEL_PATH` and `ENTHUSIA_LLAMA_SERVER_PATH`, with their exact SHA-256 hashes supplied as `ENTHUSIA_MODEL_SHA256` and `ENTHUSIA_LLAMA_SERVER_SHA256`. Startup fails closed on missing files, mismatches or changes during verification.
2. Spawn the approved local executable **without a shell**. It receives fixed flags for loopback-only HTTP, a verified model alias, at most eight CPU inference threads, at most 8,192 context tokens, one parallel slot, disabled Web UI, and disabled reasoning. No user question or model output can select executable flags.
3. Generate a fresh API key in process memory and pass it only to `llama-server` (as `LLAMA_API_KEY`) and the Agent (as `ENTHUSIA_INFERENCE_API_KEY`). Neither the Discord process nor the Gateway receives this secret.
4. Wait for **both** authenticated `/health` and `/v1/models` checks, requiring the expected model alias before starting Agent, then Gateway, then optionally Discord. A crash or failed startup tears down the supervised process tree; no Minecraft/SMP process is attached.
5. `--dry-run --managed-inference` validates required config and ports **without reading artifact bytes**. Actual checksum verification occurs before launching any children during a real staged start.

Supporting files: `managed-inference.mjs`, `single-server-staging.mjs`, typed `.d.mts` interfaces and the new tests in `tests/integration/bloom-managed-*.test.ts`.

**Caution:** These model tests use fake artifact files and synthetic HTTP responses. They prove guards and readiness logic, **not** that a model will run on Bloom or meet performance requirements.

### Container image candidate (build not performed)

`deploy/bloom/Dockerfile.single-staging` combines Node 24 and an operator-pinned `llama.cpp` source build into one image; its paired `.dockerignore` excludes local secrets, GGUF weights and development artifacts. The image defaults to **no Discord login** and cannot start without an operator-supplied model SHA and matching executable SHA.

Before any deployment, validate Docker build success on Linux, verify the exact `llama.cpp` revision and base-image digests, audit dependencies, ensure the non-root container account and persistent model mount work with Bloom, and test inference under SMP-safe CPU/memory limits. The current connected Windows test machine had **no Docker executable available**, so neither the image nor a Pterodactyl egg was tested or installed. This is a staging candidate, not a production-ready image.

Do not use an existing owner/Admin SFTP credential or inject tokens into Docker build arguments. When a Bloom-hosted model/runtime is stable, create the separate read-only SFTP identity under issue #119 with explicit owner permission.

## Persistent read-only knowledge sidecar — 2026-10-08

New staging-only components:
- `deploy/bloom/knowledge-staging.mjs` + `.d.mts`: a separately supervised **localhost-only** search service composing the existing **W08 GitHubIndexer + W04 SourceRegistry SQLite + W07 KnowledgeRetrievalEngine SQLite**. A current-only public search endpoint exists for future use by the Agent; **the Agent is not yet connected to it**.
- `--managed-indexer` opts the single-server supervisor into this process. **Default OFF.** The child is launched before Agent/Gateway only after exact approved source gating. Its GitHub source token and internal bearer API key go exclusively into the knowledge child environment, not the Discord process, Gateway, Agent or model.
- Exact initial repository allowlist: `wsg138/MaceGuard,wsg138/PieCloak`, **public README files only**. A W08 client-side tree filter excludes all non-README files before their contents are downloaded or indexed, and the public-only search gate prevents wider retrieval. No arbitrary repository, history mode, staff query scope, production-status claim, player data or private server path can be selected by a question.
- SQLite source registry and chunk store persist under an operator-approved absolute `ENTHUSIA_INDEXER_DATA_DIR`. W07 rebuilds its in-memory lexical/vector indexes from SQLite after restart. **Hashing embeddings here remain test-only**, not an approved production semantic model.
- `GET /health/ready` and `POST /v1/search` require the random in-memory service key. Both bind `127.0.0.1` only. Search accepts a single bounded `question` field and returns at most five bounded, current PUBLIC evidence excerpts with source locator and version; it explicitly sets `deploymentVerified:false`.
- The indexer rechecks the approved GitHub repos on startup and at most every 15 minutes. **It will not serve any search result until a complete successful refresh in the current process**, and results go unavailable on failed refresh, concurrent refresh or expiration after 30 minutes. Thus an old SQLite database is not automatically accepted as fresh.
- Staging requires `NODE_ENV=development`, `ENTHUSIA_BLOOM_STAGING=1`, exact `ENTHUSIA_INDEXER_APPROVED_REPOS`, an operator-injected dedicated `ENTHUSIA_INDEXER_GITHUB_TOKEN`, an absolute data directory, and `--managed-indexer`. `--smoke --managed-indexer` is rejected: the credential-free smoke must never call GitHub.

**Testing:** `tests/integration/bloom-knowledge-sidecar.test.ts` uses a synthetic W08-compatible GitHub client but **real W04 and W07 SQLite persistence**, including process re-creation and version supersession, and exercises the real loopback HTTP server. `tests/integration/bloom-single-staging.test.ts` confirms explicit opt-in, token isolation/guardrails and unique ports in dry-run mode. No GitHub source token, Docker, Bloom, live SFTP or Minecraft process was accessed.

**Incomplete:** This does **not** yet replace the special-case PieCloak/Warzones answer pilots. The Agent's verified `knowledge.search` tool, a production-quality embedding provider, per-claim citation/verification, prompt-injection boundaries, and deployment-SHA checks are still separate gates. The source is CURRENT *on GitHub*, **not verified current on SMP**. Do not import an egg, restart a Discord listener, or provision credentials until the owner separately approves it.

### W12 Agent bridge prepared, deliberately unregistered

`apps/agent-service/src/knowledge-search.ts` introduces a typed, bounded `knowledge.search` read tool that calls the localhost-only sidecar. It checks an internal bearer key, HTTP response size, source timestamps (max 30 minutes), exact approved source locators and current 40-character Git blob versions, and rejects outdated or unexpected provenance without reflecting raw errors. Its return envelope preserves W12 correlation IDs, source visibility, freshness and explicit `deploymentVerified:false`.

**It is not automatically registered in the running Agent**: the user-visible Discord bot continues to use its existing PieCloak/Warzones pilot until the full source citation/reasoner review is complete. Do not send untrusted README text as model instructions; use separate evidence boundaries and deterministic claim checks before opting in.

Further synthetic validation: `apps/agent-service/test/knowledge-search.test.ts` and `tests/integration/bloom-knowledge-readiness.test.ts`. The supervisor waits for authenticated, fresh source indexing before marking the knowledge child ready and launching Agent. No GitHub token is passed to Agent/Gateway/Discord/inference.

**Release blocker:** A real Linux/Bloom image build and model/runtime benchmark remain unavailable from the Windows test environment; neither a live GitHub index nor a SFTP session was created. Hashing embeddings used for test-sidecar retrieval are not suitable as final production semantic embeddings.

## Agent knowledge connection — 2026-10-08 (synthetic end-to-end PASSED)

The staging Agent now has an **explicitly gated, public-only source resolver** driven by the new persistent sidecar:

- With `--managed-indexer`, the staging supervisor supplies `ENTHUSIA_TEST_KNOWLEDGE_BRIDGE=1`, the internal indexer endpoint and a random service API key **only to Agent**. The GitHub credential remains **only in the knowledge-indexer process**. None of these integration variables are passed to Discord, Gateway or inference.
- `apps/agent-service/src/main.ts` enables the bridge only for `NODE_ENV=development` together with the existing isolated `ENTHUSIA_TEST_PIECLOAK_PUBLIC_DOCS=1`. An unexpected indexer endpoint or key without opt-in is a startup error. Ordinary Windows Discord testing and production defaults remain unchanged.
- `apps/agent-service/src/indexed-public-docs.ts` invokes the already validated `KnowledgeSearchTool` directly for **public explanatory PieCloak/Warzones questions**. It never gives retrieved document text to Qwen3 as instructions and does not expose the general `knowledge.search` tool to LLM planning. Only bounded safe excerpts are **visibly quoted as documentation**, not asserted to be deployed server behavior. Dynamic current-state questions are never answered by this route.
- Citation links use the **verified Git commit SHA returned by W08**, not the README blob SHA (which is a different Git object). The Discord embed displays a concise technical link with its prior wiki landing-page link. Ambiguous revisions, missing citations, malicious prompt-injection lines, stale results, private repos and wrong source paths cause explicit `unverified` results with no fake citations.
- The sidecar itself checks GitHub repository visibility on every refresh; a previously public repository becoming private makes the source unavailable, even if a SQLite copy remains.
- The bridge remains restricted to exactly the two approved **public README** documents and uses test-only hashing embeddings. It is **not a general full-server semantic knowledge system or proof of current deployed plugin versions**.

**New tests:** `apps/agent-service/test/indexed-public-docs.test.ts` proves safe excerpts and tests malicious instructions/lack of live-state evidence; `tests/integration/bloom-knowledge-sidecar.test.ts` now sends a real loopback request through actual W08/W04/W07 storage into a real Agent orchestrator using a synthetic GitHub client. It verifies that the local model is never invoked for source excerpts, citations are pinned to the indexed Git commit, revocation disables answers immediately, and a public-to-private repository transition fails closed.

**Still pending:** real approved GitHub token and running indexer, operational embedding model, full-language answer synthesis with deterministic claims, Docker/Linux container build, Bloom egg and resource benchmark, owner-approved read-only live SFTP and metric tools. This remains staging-only on draft PR #118, not merged or deployed.
