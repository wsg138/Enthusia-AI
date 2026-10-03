# Enthusia AI — Worker Execution Plan

**Status:** Initial execution plan  
**Depends on:** docs/MASTER-SPECIFICATION.md  
**Audience:** Muse, dots, coordinator agents, implementation workers, reviewers

---

# 1. Purpose

This document translates the master specification into parallel workstreams.

The goal is to let multiple 24/7 AI workers build Enthusia AI concurrently without:

- duplicating services;
- inventing conflicting schemas;
- changing architecture silently;
- creating incompatible APIs;
- coupling unrelated components;
- merging unfinished cross-service assumptions.

Every worker must read the Master Specification first.

---

# 2. Coordination rules

## 2.1 One owner per workstream

Each workstream has one implementation owner at a time.

Other workers may review, test, or provide research, but should not create competing implementations.

## 2.2 Contract-first development

Shared interfaces must be created before dependent implementations.

Examples:

- common request/response types;
- source provenance model;
- visibility enum;
- memory revision contract;
- tool result envelope;
- health/readiness contract.

## 2.3 No direct production mutation during build

Initial development is offline/test/staging.

Workers must not:

- deploy production;
- restart production;
- mutate live databases;
- change Discord permissions;
- install production credentials

unless the owner explicitly authorizes that task.

## 2.4 PR isolation

Each workstream should use a dedicated branch and PR.

PR description must include:

- scope;
- dependencies;
- tests;
- migration impact;
- configuration additions;
- unresolved risks.

## 2.5 Shared files

Changes to shared contract files require coordination.

Do not casually edit a shared schema to make one local implementation easier.

---

# 3. Dependency graph

Recommended high-level dependency order:

~~~
W01 Contracts / scaffold
   |
   +--> W02 AI Gateway
   +--> W03 Local inference adapter
   +--> W04 Source registry / provenance
   +--> W05 Memory service
   +--> W06 Discord adapter
   |
   +--> W07 Knowledge retrieval
           |
           +--> W08 GitHub indexer
           +--> W09 SFTP indexer
           +--> W10 Database tools
           +--> W11 Player identity/context
   |
   +--> W12 Agent orchestrator
           |
           +--> W13 OpenAI escalation
           +--> W14 Ticket Bot integration
           +--> W15 Moderation adapter
   |
   +--> W16 Dataset pipeline
           |
           +--> W17 Synthetic corpus
           +--> W18 Ticket corpus
           +--> W19 Fine-tune/export
   |
   +--> W20 Evaluation
   +--> W21 Deployment/observability
   +--> W22 Minecraft /ai
~~~

Not every dependency must be complete before downstream work begins; mocks/contracts should allow parallel development.

---

# 4. W01 — Repository scaffold and shared contracts

## Goal

Create the project foundation all workers consume.

## Owns

- monorepo structure;
- root package/config;
- formatting/linting;
- CI;
- shared TypeScript contracts;
- configuration conventions;
- common error types;
- visibility enum;
- source/provenance envelope;
- tool result envelope;
- trace ID conventions;
- health contract.

## Required outputs

- apps/services/packages directories;
- reproducible install;
- root test command;
- root lint/typecheck;
- packages/contracts;
- packages/config;
- packages/logging;
- example env files containing no secrets;
- CI workflow.

## Must define

Visibility:

- PUBLIC
- PLAYER_SELF
- STAFF
- MANAGEMENT
- SYSTEM_INTERNAL
- SECRET_DENY

Source status:

- CURRENT
- SUPERSEDED
- INVALID
- CONFLICTED
- STALE

## Acceptance

- clean checkout can install and test;
- no production secret required;
- shared types compile;
- CI green.

---

# 5. W02 — AI Gateway

## Goal

Create the stable API boundary used by Discord, Minecraft, Ticket Bot, and future surfaces.

## Owns

- request ingress;
- authentication;
- rate limits;
- conversation routing;
- trace IDs;
- visibility ceiling propagation;
- health endpoints.

## Initial endpoints

- POST /v1/chat
- GET /health/live
- GET /health/ready

Later:

- /v1/agent
- /v1/sources
- /v1/escalations

## Requirements

- do not implement model-specific logic;
- do not own persistent memory semantics;
- validate actor/surface;
- enforce request size;
- timeout downstream dependencies.

## Acceptance

Mock agent can receive a Discord-shaped request and return a typed response.

---

# 6. W03 — Local inference adapter

## Goal

Make local model runtime swappable and measurable.

## Owns

- inference HTTP client;
- model capabilities;
- token/context limits;
- health;
- retry/timeout;
- streaming support if used;
- metrics.

## Requirements

Support a local OpenAI-compatible endpoint when possible.

No application code should directly call llama.cpp-specific routes outside this adapter.

## Acceptance

- mock server tests;
- real small-model smoke;
- bounded timeout;
- model version exposed.

---

# 7. W04 — Source registry and provenance

## Goal

Create the canonical model for where facts came from.

## Owns

- source registry;
- source artifact schema;
- version/hash semantics;
- visibility;
- authority;
- current/superseded artifact state.

## Source types

- GITHUB
- SFTP_FILE
- DOCUMENT
- CONFIG
- DATABASE_SCHEMA
- DATABASE_LIVE
- DISCORD
- TICKET
- STAFF
- DEPLOYMENT
- GENERATED

## Acceptance

A changed file can produce a new current source artifact while previous artifact remains historical.

---

# 8. W05 — Memory service

## Goal

Implement current memory plus historical revisions.

This is a critical workstream.

## Core invariant

Old stale values must not remain in normal current retrieval.

## Owns

- MemoryKey;
- MemoryRevision;
- evidence links;
- supersession transaction;
- invalidation;
- conflict state;
- current-only query;
- history query;
- correction API.

## Required behavior

If:

    command.trade.permission = vip.trade

changes to:

    command.trade.permission = enthusia.trade

then:

- new revision CURRENT;
- old revision SUPERSEDED;
- current lookup returns only new value;
- semantic current index removes old value;
- history still returns both;
- old answer cache invalidated where implemented.

## Concurrency

Supersession must be atomic.

Two simultaneous updates must not create two CURRENT revisions.

## Acceptance tests

- replace current;
- invalidate current;
- conflict;
- history;
- current-only search;
- race/concurrency;
- evidence preservation.

---

# 9. W06 — Discord adapter

## Goal

Create Enthusia AI Discord bot surface.

## Owns

- Discord login;
- mentions;
- slash command;
- configured AI channels;
- actor context;
- role context;
- join-time context;
- response formatting;
- Discord rate/error handling.

## Initial behavior

Respond only to explicit mention/slash/configured test channel.

Do not begin broad automatic interception yet.

## Must not own

- reasoning;
- memory;
- GitHub search;
- ticket state.

## Acceptance

A Discord message reaches AI Gateway and returned response is sent under Enthusia AI bot identity.

---

# 10. W07 — Knowledge retrieval engine

## Goal

Provide current evidence search across indexed artifacts.

## Owns

- hybrid search;
- vector search;
- lexical/exact search;
- metadata filters;
- visibility filter;
- current-only default;
- source result ranking;
- chunking abstractions.

## Critical requirement

Default retrieval must not return SUPERSEDED content as current.

Historical search must be explicit.

## Acceptance

Queries return current source chunks with provenance/version.

---

# 11. W08 — GitHub indexer

## Goal

Understand approved Enthusia repositories deeply.

## Owns

- repository registry;
- clone/API ingestion;
- SHA tracking;
- incremental indexing;
- source files;
- docs;
- issues/PR metadata where enabled;
- code symbol extraction where practical.

## Required relationships

At minimum derive when possible:

- repo -> plugin/component;
- plugin -> commands;
- plugin -> permissions;
- file -> source SHA.

## Current-production caution

Do not label Git main as deployed unless deployment data proves it.

## Acceptance

Change a test repo commit and confirm stale chunks are superseded.

---

# 12. W09 — SFTP/server file indexer

## Goal

Build read-only knowledge from approved production/staging files.

## Owns

- allowlisted server roots;
- read-only SFTP;
- file metadata;
- hashes;
- incremental parsing;
- secret deny patterns;
- reconciliation scheduling.

## Security

Hard deny examples:

- .env
- credentials
- private keys
- tokens
- secret backups

Do not rely only on prompt instructions to hide secrets.

## Acceptance

- detects changed config;
- re-indexes changed source;
- unchanged files skipped;
- denied paths cannot be read through AI tool.

---

# 13. W10 — Database safe tools

## Goal

Expose current live database facts without giving the model arbitrary database power.

## Owns

- read-only connection;
- purpose-built query functions;
- schema descriptions;
- result provenance;
- timeout/row limits.

## Initial tool examples

- resolve linked account;
- get player rank;
- get selected permission state;
- get ticket metadata;
- get approved economy fact.

## Must not

- accept arbitrary generated UPDATE/DELETE;
- expose DB credentials;
- dump full tables into prompt.

---

# 14. W11 — Player identity/context

## Goal

Create normalized player identity across Discord and Minecraft.

## Owns

- Discord ID -> Minecraft UUID;
- current usernames;
- Bedrock identity where available;
- role/rank context;
- scope/visibility.

## Requirement

Context access is relevance-based.

Do not automatically fetch unrelated private history.

---

# 15. W12 — Agent orchestrator

## Goal

Implement the local AI's investigative behavior.

This is another critical workstream.

## Owns

- intent;
- evidence plan;
- tool selection;
- investigation loop;
- tool budgets;
- claim verification;
- escalation decision;
- response assembly;
- memory update proposals.

## Required policy

For mutable Enthusia facts, the final answer must have current evidence.

## Tool budget classes

Simple:
- small retrieval/tool budget.

Investigative:
- larger bounded budget.

Engineering:
- gather evidence and escalate.

## Required behaviors

- expand search when evidence incomplete;
- recognize contradictions;
- not answer from stale model recollection;
- not query irrelevant private context;
- not loop indefinitely.

## Acceptance

Golden scenarios must include:

- server IP;
- permission issue;
- known bug;
- missing evidence;
- conflicting evidence;
- stale memory;
- irrelevant private context.

---

# 16. W13 — OpenAI escalation

## Goal

Provide a stronger-model/coding escalation path.

## Owns

- escalation policy adapter;
- packet builder;
- OpenAI API integration;
- model selection config;
- timeout;
- cost tracking;
- response normalization.

## Packet contains

- question;
- goal;
- evidence;
- sources;
- repos/SHAs;
- logs;
- attempted local diagnosis;
- constraints;
- authorization.

## Budget

Runtime OpenAI budget must be separately configurable.

Training GPU $25 cap does not automatically define API budget.

## Acceptance

Mock and real non-destructive test of structured escalation.

---

# 17. W14 — Ticket Bot integration

## Goal

Separate AI reasoning from existing Enthusia Support lifecycle.

## Owns in Enthusia-AI repo

- Ticket Bot API client;
- ticket-context adapter;
- AI action requests;
- event consumption;
- migration compatibility.

## Requires support-bot changes

A coordinated worker in wsg138/enthusia-support-bot may add typed endpoints/events.

## Invariant

Ticket Bot remains source of truth for ticket state and permissions.

## Migration

- shadow first;
- compare;
- move generation;
- move bot identity;
- remove old duplicate AI authority last.

---

# 18. W15 — Moderation adapter

## Goal

Integrate with the separate moderation AI without coupling availability.

## Owns

- moderation service client;
- shared identity metadata if required;
- optional decision context.

## Must not

- route real-time moderation through support LLM;
- make moderation dependent on AI Gateway.

---

# 19. W16 — Dataset foundation

## Goal

Create versioned normalized training datasets.

## Owns

- schema;
- manifests;
- dedupe;
- splits;
- quality metadata;
- secret scan;
- dataset versioning;
- deterministic preprocessing.

## Required partitions

At minimum:

- train;
- validation;
- test/golden.

Do not tune on frozen final evaluation data.

---

# 20. W17 — Synthetic corpus generation

## Goal

Generate large high-quality synthetic training material from current Enthusia knowledge.

## Owns

- scenario generation;
- source-grounded Q&A;
- tool traces;
- adversarial examples;
- quality validation.

## Categories

- onboarding;
- commands;
- permissions;
- rank;
- economy;
- tickets;
- rules;
- bugs;
- account linking;
- ambiguity;
- escalation;
- stale data;
- conflicting evidence;
- privacy.

## Acceptance

Every factual synthetic example has traceable supporting sources.

---

# 21. W18 — Historical ticket corpus

## Goal

Implement the owner-directed plan to use historical support tickets as a training source.

## Before extraction

Produce a documented data-governance checkpoint covering:

- source;
- authorization;
- platform/data obligations;
- retention;
- exclusions;
- privacy/secrets.

## Pipeline goals

- structured issue/outcome extraction;
- quality labeling;
- outdated-answer marking;
- redaction configuration;
- secret removal;
- evidence-request patterns;
- staff-decision patterns.

## Critical rule

Historical ticket facts do not outrank current live facts.

A historical decision can teach process while its old configuration fact is stale.

---

# 22. W19 — Fine-tuning and export

## Goal

Fine-tune candidate local model.

## Budget constraint

Initial rented GPU spend must not exceed $25 without explicit owner approval.

## Process

- local pipeline smoke;
- small adapter run;
- evaluate;
- full run;
- evaluate;
- optional second run if budget permits;
- quantize;
- artifact manifest.

## Hardware

Owner PC:
- RTX 4060 Ti 8 GB;
- 64 GB RAM.

Use PC for preprocessing and smaller experiments.

Use rented high-VRAM GPU when justified.

## Acceptance

Artifact includes:

- base model;
- adapter;
- dataset version;
- hyperparameters;
- hashes;
- evaluation report.

---

# 23. W20 — Evaluation and golden suite

## Goal

Make model/system quality measurable.

## Owns

- golden dataset;
- evaluator;
- tool accuracy tests;
- stale-fact tests;
- visibility tests;
- escalation tests;
- regression reporting.

## Mandatory stale test

A -> B source update must result in:

- current answer B;
- history A;
- no normal retrieval of A as current.

## Acceptance

CI or scheduled evaluation produces machine-readable report.

---

# 24. W21 — Bloom deployment, observability, and resource isolation

## Goal

Run system without harming SMP.

## Owns

- Pterodactyl deployment;
- process supervisor;
- resource limits;
- health;
- metrics;
- logs;
- startup;
- model persistence;
- rollback.

## Initial model RAM

Target roughly 24–32 GB until benchmark says otherwise.

## CPU

Explicitly bound inference/indexing concurrency.

## SMP benchmark

Measure before and during:

- local inference;
- indexing;
- model startup;
- concurrent queries.

## Acceptance

AI process failure does not stop SMP, moderation, or Ticket Bot.

---

# 25. W22 — Minecraft /ai

## Goal

Expose shared AI to Minecraft after Discord/core stabilize.

## Owns

- Paper plugin;
- /ai;
- async HTTP;
- permissions;
- rate limits;
- identity/context;
- formatting;
- Geyser compatibility.

## Must not

Implement separate model reasoning.

---

# 26. Review workstreams

In addition to implementers, coordinator should dispatch independent reviewers for:

- security;
- memory semantics;
- visibility/privacy;
- performance;
- training/evaluation;
- Ticket Bot integration.

Reviewers should not self-approve their own implementation.

---

# 27. Initial parallel launch recommendation

After W01 contracts exist, launch in parallel:

- W02 Gateway;
- W03 inference;
- W04 provenance;
- W05 memory;
- W06 Discord;
- W16 dataset;
- W20 evaluation;
- W21 deployment skeleton.

Then:

- W07 retrieval;
- W08 GitHub;
- W12 orchestrator.

Then remaining connectors/integrations.

This maximizes useful parallelism without interface chaos.

---

# 28. Coordinator status format

Each worker should report:

~~~
WORKSTREAM:
BRANCH:
PR:
HEAD SHA:

DONE:
- ...

TESTS:
- ...

DEPENDENCIES:
- ...

BLOCKERS:
- ...

RISKS:
- ...

READY FOR REVIEW:
YES/NO
~~~

---

# 29. Cross-repo changes

If a worker needs another repository:

- state why;
- create a separate branch/PR there;
- link both PRs;
- do not hide cross-repo dependency.

Relevant likely repositories include:

- wsg138/enthusia-support-bot;
- wsg138/AI-Moderation-API;
- Enthusia Minecraft plugin repositories.

---

# 30. Worker definition of done

A workstream is not done when code compiles.

Done requires:

- implementation;
- tests;
- docs;
- error handling;
- health/observability where relevant;
- no leaked secrets;
- interface contract honored;
- migration/rollback documented when applicable;
- independent review for critical workstreams.

---

# 31. Critical workstreams requiring extra review

At minimum:

- W05 Memory;
- W09 SFTP;
- W10 Database tools;
- W12 Agent;
- W13 OpenAI escalation;
- W14 Ticket integration;
- W18 ticket corpus;
- W19 training;
- W21 deployment.

---

# 32. Coordinator priority

Do not optimize for number of merged PRs.

Optimize for:

1. stable contracts;
2. correct current-truth semantics;
3. security;
4. testability;
5. useful incremental demos;
6. safe production rollout.

The project should become useful early, then grow in capability without rewriting its foundation.
