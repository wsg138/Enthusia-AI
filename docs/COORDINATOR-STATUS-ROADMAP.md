# Enthusia AI — Coordinator Status and Roadmap

Last updated: 2026-10-06

This document is the coordinator-facing operational status for Enthusia AI. It does not replace the detailed architecture specifications; it connects them to the current implementation, deployment state, open work, and future roadmap.

## 1. Product goal

Enthusia AI is intended to become the server-wide intelligence layer for Enthusia, not a static FAQ bot.

Target shape:

```
player/staff surface
        ↓
AI Gateway
        ↓
AgentOrchestrator
        ↓
local reasoning model
        ↓
typed tools + current evidence + verified memory
        ↓
bounded action requests / OpenAI escalation when appropriate
```

Primary use cases:

- Discord support and ticket investigation;
- Minecraft `/ai`;
- staff assistance;
- current plugin/server understanding;
- GitHub/source/config investigation;
- persistent evidence-backed memory;
- player-specific context and adaptive explanation depth;
- local-model handling for routine work;
- OpenAI escalation for deep engineering/investigation;
- bounded typed actions where a deterministic authority validates them;
- later proactive support, diagnostics, automation, economy intelligence, event/NPC assistance, and development workflows.

The expected action pattern remains:

> AI proposes a structured decision → deterministic policy/auth checks it → a typed tool requests or performs only the explicitly authorized operation.

## 2. Source-of-truth rules

For mutable/current Enthusia facts, use this authority order:

1. fresh verified live runtime/deployment evidence;
2. exact deployed-artifact provenance;
3. fresh canonical source/config evidence;
4. current structured memory;
5. generic model knowledge.

Never infer any of the following:

- GitHub main = production;
- merged = deployed;
- deployed = restarted;
- enabled in config = healthy at runtime;
- TestServer = newer/more authoritative than SMP;
- matching filename = matching binary.

Every coordinator update should distinguish:

- source intent;
- GitHub main;
- merged;
- deployed;
- restarted;
- runtime verified.

## 3. Safety and authority boundaries

### Secrets

Reusable credentials remain tool/runtime-owned and must never become model-visible data.

Never expose to prompts, model output, memory, embeddings, training data, or logs:

- passwords;
- API/bot tokens;
- OAuth secrets;
- private keys;
- DB passwords;
- SFTP credentials;
- signing/HMAC secrets;
- reusable Authorization headers;
- secret-bearing environment values.

### System separation

Do not collapse these systems into one authority:

- **Enthusia-AI** — reasoning, retrieval, verified memory, typed-tool orchestration, support intelligence;
- **AI-Moderation-API** — real-time moderation classification/model work;
- **EnthusiaStaff** — staff platform, punishments, DiscordSRV replacement and staff operational tooling;
- **enthusia-support-bot** — ticket creation/state/permissions/transcripts/archive/lifecycle authority.

For tickets, Enthusia AI may read context and request actions. Ticket Bot independently validates and executes lifecycle changes.

For moderation, support AI may investigate, summarize, gather evidence, explain, and recommend/escalate. It is not unrestricted punishment authority.

## 4. Completed foundation

W01–W22 are considered complete unless a regression is found:

- W01 scaffold/shared contracts;
- W02 AI Gateway;
- W03 local inference;
- W04 source registry/provenance;
- W05 memory;
- W06 Discord adapter;
- W07 knowledge retrieval;
- W08 GitHub indexer;
- W09 SFTP/live-source architecture;
- W10 safe database tools;
- W11 player identity/context;
- W12 AgentOrchestrator;
- W13 OpenAI escalation;
- W14 Ticket Bot integration contract;
- W15 moderation adapter;
- W16 dataset pipeline;
- W17 synthetic corpus;
- W18 historical-ticket governance;
- W19 fine-tune/export;
- W20 evaluation;
- W21 deployment/observability;
- W22 Minecraft `/ai`.

Primary specs:

- `docs/MASTER-SPECIFICATION.md`
- `docs/MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md`
- `docs/TRAINING-AND-EVALUATION-SPEC.md`
- `docs/WORKER-EXECUTION-PLAN.md`

## 5. Live plugin intelligence

The read-only Live Plugin Intelligence Audit is complete.

Audit material lives under:

`docs/audits/live-plugin-intelligence/`

Important outputs include:

- SMP plugin inventory and metadata;
- dependency/command/permission catalogs;
- current feature state;
- runtime integration graph;
- deployment provenance;
- runtime health;
- source-registry drift;
- TestServer comparison;
- freshness/staleness tracking;
- model-exposure boundary;
- third-party exact-version map;
- missing typed-tool roadmap.

Current known unresolved provenance remains tracked in issue #39:

- EnthusiaDisplay;
- EnthusiaMapShields;
- local PoseProbe provenance/cleanup.

Fresh non-SMP coverage remains tracked in issue #40.

## 6. Recent production-runtime work

### Agent production composition root

Merged PR #44 added the production `agent-service` composition root.

Production architecture now contains:

`surface → AI Gateway → agent-service → AgentOrchestrator → registered typed tools / inference`

The local model proposes intent, evidence plans, and bounded tool calls through strict JSON. It does not own factual truth or consequential policy.

### Typed current plugin intelligence

Merged PR #42 added:

- `server.current_plugin_deployment`;
- `server.current_target_freshness`;
- `server.current_plugin_interface`.

These are intentionally narrow read tools. Issue #41 remains open because additional typed surfaces are still planned.

### Ticket Bot production-tool registration

Merged PR #46:

- makes the W14 Ticket Bot backend optional but production-registerable in `agent-service`;
- requires Ticket Bot URL/API key as a complete pair;
- keeps the credential runtime-only;
- registers bounded tools only;
- adds no arbitrary ticket mutation primitive.

Registered lifecycle integration currently includes:

- `ticket.get_context`;
- `ticket.request_close`;
- `ticket.request_escalation`.

Issue #27 remains open until both repositories are actually deployed/configured/restarted and runtime-verified together.

## 7. Ticket platform status

### Ticket Bot authenticated lifecycle API

`wsg138/enthusia-support-bot` PR #13 is merged.

The Support Bot provides an authenticated internal lifecycle API with:

- allowlisted DTOs;
- ticket/context/message/participant reads;
- durable action requests;
- correlation/idempotency controls;
- Ticket Bot permission/state/conflict revalidation;
- HMAC event support;
- bounded bodies/timeouts;
- no direct Prisma access from Enthusia AI.

Ticket Bot remains authoritative for ticket lifecycle.

### Seven-day stale-ticket reactivation

Enthusia-AI PR #45 and support-bot PR #14 are merged. Issue #31 is complete.

Behavior:

- only open tickets with at least seven days of meaningful inactivity are candidates;
- AI returns only a typed recommendation:
  - `PING_PLAYER`;
  - `PING_STAFF`;
  - `KEEP_PAUSED`;
  - `ESCALATE_STAFF`;
  - `NO_ACTION`;
- Ticket Bot re-checks live state immediately before delivery;
- reminder wording/delivery remains Ticket Bot controlled;
- reminder and pause cooldown is seven days;
- `NO_ACTION` is not reconsidered more than daily;
- completed decisions are auditable TicketEvents;
- model/API failure does not mutate or close a ticket.

### Deployed-capability handshake

Support-bot PR #15 is merged and adds authenticated:

`GET /v1/capabilities`

It reports the exact deployed W14 contract/version and allowed reads/actions without exposing credentials or backend internals.

Enthusia-AI PR #47 is the companion client/tool work. It must remain fail-closed if the running Ticket Bot does not expose a compatible contract.

This is important because source-main capability is not deployment truth.

## 8. Ticket work still planned

### Issue #27 — production runtime deployment

Remaining runtime gate:

1. deploy the current Support Bot source;
2. execute the Prisma deployment migration through the normal launcher;
3. enable/configure the internal Ticket API;
4. deploy/configure agent-service Ticket Bot backend;
5. verify authenticated capability handshake;
6. test read-only ticket context;
7. test a safe action-request path;
8. verify idempotency/rejection behavior;
9. verify logs contain no secrets;
10. only then consider migration/shadow-mode decisions for existing Support Bot AI behavior.

### Issue #30 — multimodal ticket evidence

Goal:

- screenshots;
- in-game chat images;
- hacking/cheating clips;
- other report evidence.

Required direction:

- preserve attachment provenance: ticket/message/source/submitter/time/id;
- strict MIME/size/type validation;
- never let the model invent arbitrary fetch URLs;
- distinguish observed visual facts from model inference;
- treat OCR as evidence, not automatically authoritative truth;
- correlate evidence with live server/moderation state;
- avoid duplicate escalation when action/review already exists;
- ask for missing evidence when useful;
- produce compact staff review summaries;
- no automatic punishment authority.

Existing Support Bot image-context code is useful prior work but does **not** by itself satisfy #30. Full provenance-preserving multimodal evidence assessment and bounded video handling still need implementation.

### Issue #33 — adaptive explanation depth

Target result:

`player.topic_familiarity(player, topic) -> NEW | FAMILIAR | EXPERT | UNKNOWN + confidence`

Rules:

- familiarity should be topic-specific;
- do not assume an old player knows every system;
- do not assume every player is new;
- private memory should shape style silently rather than being quoted to prove personalization;
- current verified context outranks stale memory;
- facts must stay identical while explanation depth changes.

New/unfamiliar players get one brief concept explanation, then the answer.
Familiar players get the direct answer.
Unknown familiarity gets one short context sentence, not a tutorial.

This must be implemented in the shared player-context/memory/orchestrator path rather than hard-coded per plugin command.

## 9. AI answer-quality rules

Player-facing answers should be conversational and goal-oriented instead of exposing internal documentation structure.

Avoid unnecessary:

- permission nodes;
- backend terminology;
- raw command tables;
- implementation details;
- verbose internal source language.

### Staff/internal boundary

A normal player may mention a staff command they already know.

That is not a license for the assistant to teach or expand it.

For player-facing requests involving staff/internal controls:

- acknowledge at a high level;
- do not repeat/expand hidden syntax;
- do not reveal permission nodes/backend/operator steps;
- say the control is staff/internal;
- redirect to the player-facing path if one exists;
- focus on the player's actual goal.

### Important factual regressions

Until stronger current authoritative evidence changes them:

- there is **no Elite rank**;
- normal players do **not** have general `/fly`.

Training/evaluation should retain these as regressions.

## 10. Training and source-grounding status

Active training/source branch:

- PR #25;
- branch `training/bootstrap-data-prep`.

Do not merge PR #25 just because CI is green.

Owner-review gate remains mandatory:

1. generate 10;
2. automated validation;
3. coordinator manually reviews all 10;
4. fix systemic problems;
5. re-run as needed;
6. show reviewed 10 to Lincoln;
7. owner approval;
8. generate/review 30;
9. owner approval;
10. only then admit to W16.

Known corpus state from the current coordinator handoff:

- canonical source corpus rebuilt across approximately 42 repositories;
- no failed repositories in the rebuild;
- refreshed RAG/synthetic grounding corpora;
- 1,200-job owner-review pool;
- several generator-quality safeguards added around staff boundaries, category/earning inference, tick/rate relationships, deployment qualifiers, grounding vocabulary, and benchmark-run contamination.

Important local-work warning:

The handoff reported local, potentially uncommitted generator-quality work on Lincoln's PC. Before modifying PR #25 locally:

- fetch;
- inspect status;
- compare local HEAD to origin;
- preserve local diff;
- do not reset away uncommitted work.

Do not train mutable production facts into model weights as authority.

## 11. Current local-model direction

Current leading local reasoning model:

- Qwen3.5-35B-A3B Q4_K_M;
- approximately 21 GB;
- local llama.cpp server;
- constrained GPU offload due RTX 4060 Ti 8 GB.

General routing direction:

- Tier 0: deterministic logic;
- Tier 1: smaller/fast model where useful later;
- Tier 2: main local reasoning model;
- Tier 3: OpenAI escalation.

Accuracy and evidence-grounding outrank latency.

Moderation-model training is a separate project and must not be conflated with Enthusia-AI.

## 12. Remaining current issues

### #36 — RoseChat production presence artifact mismatch

Current production artifact is missing the expected presence API used by EnthusiaTags. Treat this as a deployment mismatch until explicitly deployed/restarted/verified.

### #37 — advancement Discord icon degradation

Current deployed Paper/addon combination has a runtime compatibility failure in the Discord advancement icon path. Text announcements continue; image rendering should not be described as healthy.

### #39 — unresolved deployed-plugin source provenance

Resolve exact sources for the remaining unidentified/local artifacts. Do not guess repositories.

### #40 — stale non-SMP live coverage

Restore fresh read-only evidence for Hub, Velocity, Test2, Build, and Sentinel. Stale snapshots must not answer current-state questions.

### #41 — remaining typed intelligence surfaces

Already implemented:

- current plugin deployment;
- target freshness;
- current plugin interface;
- production AgentOrchestrator composition;
- Ticket Bot production tool registration.

In progress / still needed:

- deployed Ticket Bot capability verification (PR #47);
- feature-state reads where not already sufficiently represented;
- safe config read surfaces;
- runtime-health reads;
- source-vs-deployment comparison;
- permission-aware help where appropriate;
- player-topic familiarity (#33).

Prefer narrow typed reads over generic system access.

## 13. Deployment and mutation policy

Read-only live access does not imply mutation authorization.

For any future live write capability:

1. investigate read-only;
2. propose the exact change;
3. validate target/path/current hash and secret boundaries;
4. back up;
5. require the appropriate authorization;
6. apply only the bounded change;
7. verify;
8. run safe validation;
9. roll back if necessary;
10. treat restart/reload as a separate permission.

Never expose to the model:

- arbitrary shell;
- unrestricted SFTP writes;
- arbitrary SQL;
- unrestricted filesystem writes.

## 14. Future roadmap

Keep these as explicit future directions rather than accidental scope creep:

- adaptive onboarding and support;
- proactive but non-spammy support;
- richer staff-assistant workflows;
- player/topic familiarity;
- economy intelligence;
- anomaly detection;
- NPC/quest/event assistance;
- plugin orchestration;
- diagnostics and cross-server reasoning;
- natural-language staff operations backed by deterministic authorization;
- coding/development assistance;
- current-state change detection;
- safe bounded AI-assisted actions;
- multimodal evidence;
- improved player-context continuity;
- support-quality learning from approved ticket precedents;
- stronger model routing based on task complexity;
- better runtime health/capability negotiation across integrations.

Any high-impact feature must preserve the same authority model: model reasoning may propose; deterministic policy and the authoritative subsystem decide what may actually happen.

## 15. Coordinator execution order

Unless live evidence changes priority, use this order:

1. finish/merge deployed Ticket Bot capability handshake;
2. keep issue/roadmap state synchronized with merged source;
3. finish #33 adaptive familiarity path;
4. build #30 multimodal evidence in bounded stages, starting with images/provenance before video;
5. complete #27 deployment/runtime verification when production-write/restart authorization is explicitly available;
6. restore stale live coverage (#40);
7. resolve source provenance (#39);
8. keep #36/#37 as explicit production health/deployment issues;
9. continue PR #25 only through the owner-review training gate;
10. expand future typed tools based on real support/staff use cases rather than generic access.

## 16. Definition of “done”

A feature is not “done” merely because code exists.

Use these statuses explicitly:

- **designed** — specification/issue exists;
- **implemented** — code exists on a branch;
- **reviewed** — tests/review complete;
- **merged** — present on canonical main;
- **deployed** — artifact/config installed;
- **restarted** — process/server has loaded the deployed artifact;
- **runtime verified** — expected behavior confirmed against the authoritative live system.

Coordinator reports should state the highest verified level instead of collapsing these stages.
