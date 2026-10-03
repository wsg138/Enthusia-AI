# Enthusia AI — Master Specification

**Status:** Authoritative project specification  
**Repository:** wsg138/Enthusia-AI  
**Owner:** wsg138 / Enthusia  
**Initial specification date:** 2026-10-03  
**License:** Proprietary, All Rights Reserved

---

# 1. Purpose of this document

This document defines the target product, architecture, safety boundaries, data model, memory semantics, knowledge system, training strategy, inference strategy, external-model escalation, Discord behavior, Minecraft behavior, ticket integration, moderation integration, deployment model, evaluation requirements, observability requirements, and implementation workstreams for Enthusia AI.

This is not a loose design memo. It is the authoritative implementation contract for the project.

Workers implementing Enthusia AI must:

1. read this document before making architectural decisions;
2. preserve the boundaries and invariants defined here;
3. avoid creating competing subsystems for concepts already defined here;
4. document any intentional deviation;
5. update this specification when the owner deliberately changes a product decision;
6. prefer interoperable services and explicit contracts over tightly coupled implementation shortcuts.

If code and this specification disagree, the code should be treated as incorrect unless this specification has intentionally been amended.

---

# 2. Product vision

Enthusia AI is a server-wide intelligence platform for the Enthusia Minecraft network.

It is not merely:

- a chatbot;
- a ticket helper;
- a FAQ responder;
- a moderation classifier;
- a coding agent;
- a retrieval system;
- or a Discord bot.

It is a persistent, tool-using AI layer that understands the Enthusia network, verifies current facts before stating them, proactively investigates relevant context, retains evidence-backed operational memory, assists players and staff, integrates with tickets, participates in Discord, eventually participates in Minecraft through an /ai command, coordinates local models and stronger external models, and learns from approved training data and operational corrections.

The desired user experience is that Enthusia has its own resident AI which understands the server deeply and can answer questions using current evidence rather than generic model memory.

Examples:

- A new Discord member asks for the server IP. Enthusia AI verifies the current server address, notices that the member joined recently if that context is useful and permitted, welcomes them, and provides the correct connection information.
- A player asks why they cannot use a command. Enthusia AI identifies the linked Minecraft account, checks current roles/ranks/permissions, checks the relevant command/plugin/configuration, and explains the actual reason rather than guessing.
- A player reports a bug. Enthusia AI checks known issues, recent deployments, current plugin code/configuration, relevant logs or records exposed through safe tools, and either explains the issue or escalates it.
- A staff member asks how a custom feature works. Enthusia AI searches current source/configuration/documentation and gives an evidence-backed explanation.
- A technical issue requires deep multi-repository investigation or code changes. Enthusia AI prepares a structured evidence packet and delegates the engineering task to OpenAI or another approved stronger coding model.
- A support ticket needs to be closed. Enthusia AI requests the action through the Ticket Bot API; it does not bypass the Ticket Bot's lifecycle authority.
- A server feature changes. Enthusia AI stops treating old information as current, updates the active knowledge/memory view, preserves the old value only in history, and verifies the new value before answering future questions.

---

# 3. Primary goals

## 3.1 Server expertise

Enthusia AI should become deeply knowledgeable about the complete Enthusia environment, including where authorized:

- server addresses and connection methods;
- network layout;
- proxies and backend servers;
- plugins;
- plugin commands;
- plugin permissions;
- configuration;
- ranks and role mappings;
- custom features;
- economy systems;
- events;
- staff processes;
- support procedures;
- rules and policies;
- database schemas;
- selected current database state;
- deployment history;
- GitHub repositories;
- source code;
- pull requests;
- commits;
- known bugs;
- fixes;
- changelogs;
- server documentation;
- Discord structure;
- account-linking systems;
- player-facing systems;
- operational procedures;
- ticket workflows;
- moderation architecture.

The system should know where information came from and whether it is current.

## 3.2 Evidence-first answers

The AI must not treat its trained weights as authoritative for current Enthusia facts.

Before stating a current Enthusia-specific factual claim, it should verify the claim against authoritative evidence when such evidence is available.

Model memory may help decide where to look. It is not the final authority.

## 3.3 Proactive investigation

The AI should not wait for the user to explicitly say "search GitHub" or "check my role."

When context is relevant and access is permitted, the AI should proactively investigate.

It should be trained and orchestrated to ask:

- What facts does this answer depend on?
- Which sources are authoritative?
- Is this information likely to change?
- Is player-specific context relevant?
- Do I already have verified current evidence?
- Are there contradictions?
- Should I inspect another system before answering?
- Is this outside the local model's expertise?
- Should this be escalated to a stronger model?

## 3.4 Local-first operation

Routine support and server-specific reasoning should primarily use local inference running on Enthusia-controlled infrastructure.

The local AI should handle as much routine work as practical without unnecessary external API calls.

## 3.5 Strong-model escalation

OpenAI remains an intentional part of the architecture.

The local AI is not expected to replace frontier models for:

- difficult coding;
- complex debugging;
- multi-repository architectural analysis;
- high-complexity technical reasoning;
- difficult security analysis;
- difficult tool-use plans;
- code modifications;
- pull request creation/review when a stronger coding agent is appropriate.

The local AI should be able to coordinate and call the stronger model.

## 3.6 Persistent current memory

The AI should develop long-term knowledge from approved sources and interactions, but stale information must not remain in the primary/current memory.

The system must distinguish:

- current belief;
- superseded belief;
- historical evidence;
- unresolved/conflicting belief.

Old information may remain for audit/history but must leave normal current retrieval when superseded.

## 3.7 Shared intelligence across surfaces

Discord support, ticket support, future Minecraft /ai, staff tooling, and other future interfaces should use the same core intelligence platform rather than independent chatbot implementations.

---

# 4. Explicit non-goals

The first production versions are not intended to:

- replace all human staff;
- allow unrestricted autonomous administrative actions;
- give the local model arbitrary shell access;
- expose secrets to the model;
- let the local model directly mutate production databases;
- let the AI directly bypass Ticket Bot lifecycle rules;
- make moderation depend on a slow generative model;
- force every simple question through OpenAI;
- continuously retrain because one configuration value changed;
- store every old memory as equally valid;
- scan every available player datum for every trivial question;
- give all Discord users access to staff-private information;
- use one giant process for moderation, inference, Discord, indexing, and training.

---

# 5. Core invariants

The following rules are mandatory unless the owner explicitly changes them.

## 5.1 Current truth beats model memory

For current Enthusia facts:

**authoritative live evidence > verified indexed evidence > current structured memory > trained model recollection**

A local model may remember a fact from training, but if the current source differs, the current source wins.

## 5.2 Verify before asserting

When an answer contains a factual statement about the current Enthusia network and an authoritative source is available, verify it before asserting it.

This does not mean every response must query every system.

It means the agent must perform enough relevant verification to support the answer.

## 5.3 Old memory is not current memory

When fact B supersedes fact A:

- B becomes current;
- A is removed from the active/current retrieval view;
- A is preserved as historical evidence;
- normal question answering must not retrieve A as a current fact;
- historical questions may retrieve A when the requested time period makes it relevant.

## 5.4 History is append-only; current state is replaceable

The platform should preserve audit/history while presenting a clean materialized current-state view.

The history answers:

- what did we believe?
- when?
- based on what evidence?
- what changed it?

The current view answers:

- what is the best-supported current truth now?

## 5.5 Tools hold credentials; models do not

Secrets must not enter:

- prompts;
- embeddings;
- training datasets;
- model weights;
- normal logs;
- persistent memories.

Tools may use credentials internally.

## 5.6 Least privilege

Every connector/tool receives the narrowest access needed.

Read-only access is the default.

Write actions require explicit scoped APIs and authorization.

## 5.7 Moderation is operationally isolated

The chat moderation classifier must continue functioning independently of support-model health.

A slow or crashed support model must not take moderation offline.

## 5.8 Ticket Bot remains ticket lifecycle authority

Enthusia AI may request ticket actions through a contract/API.

It must not become a second independent authority over ticket state.

## 5.9 Stronger models are escalation resources

The local model should know when to escalate.

Escalation should be policy-driven, not based only on the model saying it feels uncertain.

---

# 6. Product surfaces

## 6.1 Discord — Enthusia AI bot

Enthusia AI should eventually have its own Discord application/bot identity, separate from Enthusia Support.

Suggested visible name:

**Enthusia AI**

The exact name may be changed by the owner.

The bot should support:

- direct mentions;
- configured AI/help channels;
- ticket conversations;
- staff-only AI channels;
- optional contextual intervention where appropriate;
- slash commands;
- staff investigation commands;
- administrative health/debug commands;
- future opt-in conversational surfaces.

It should not spam every conversation.

A policy layer should decide whether the AI should respond.

## 6.2 Ticket support

The current Ticket AI functionality should migrate behind Enthusia AI.

The Ticket Bot should remain responsible for:

- ticket creation;
- permissions;
- channel lifecycle;
- close confirmation;
- transcripts;
- archiving;
- applications;
- staff permission enforcement;
- ticket persistence.

Enthusia AI should own:

- AI reasoning;
- response generation;
- ticket understanding;
- memory;
- knowledge retrieval;
- server investigation;
- external-model escalation.

Ticket messages should eventually be sent under the Enthusia AI identity rather than appearing to come from the Ticket Bot where Discord architecture permits.

## 6.3 Minecraft /ai

A later Minecraft plugin should expose the same AI through commands such as:

    /ai <question>

Possible future additions:

    /ai ask <question>
    /ai history
    /ai clear
    /ai help

The Minecraft plugin should be thin.

It should:

- authenticate the player;
- include server/player context;
- call the Enthusia AI API;
- render the answer safely;
- handle rate limits/timeouts;
- avoid implementing a separate reasoning engine.

## 6.4 Staff investigation surface

Staff should be able to ask deeper questions that ordinary players cannot.

Examples:

- Why was this ticket escalated?
- What evidence do we have for this bug?
- What changed in this plugin recently?
- Has this issue happened before?
- What permissions does this player currently have?
- Compare this behavior against current code.
- Prepare an engineering investigation.

Staff access must be permission-scoped.

## 6.5 Future web/admin interface

A future dashboard may expose:

- memory/current knowledge;
- historical revisions;
- evidence sources;
- model health;
- escalations;
- tool calls;
- indexing status;
- evaluation results;
- AI corrections;
- cost;
- GPU/resource usage.

This is not required for initial MVP.

---

# 7. High-level architecture

Target architecture:

~~~
Discord
   |
   v
Enthusia AI Discord Adapter
   |
   v
AI Gateway / Agent API
   |
   +---------------------------+
   |                           |
   v                           v
Local Support Model        Policy / Router
   |                           |
   +-------------+-------------+
                 |
        Agent Orchestrator
                 |
        +--------+---------+------------------+------------------+
        |                  |                  |                  |
        v                  v                  v                  v
 Knowledge/RAG         Memory Service      Tool Gateway      OpenAI Gateway
        |                  |                  |                  |
        |                  |          +-------+--------+         |
        |                  |          |       |        |         |
        v                  v          v       v        v         v
   Qdrant/index         AI DB       GitHub  SFTP/DB  Ticket   Stronger
                                           tools     API      models

Separate operational path:

Minecraft + Discord chat
         |
         v
 Moderation Service
 fast classifier / rules
         |
         v
 moderation decisions
~~~

The actual technologies may evolve, but the service boundaries must remain clear.

---

# 8. Recommended repository layout

Initial target:

~~~
/
  README.md
  LICENSE
  docs/
    MASTER-SPECIFICATION.md
    WORKER-EXECUTION-PLAN.md
    architecture/
    security/
    training/
    evaluation/
    operations/
  apps/
    discord-bot/
    ai-gateway/
  services/
    agent-core/
    knowledge-indexer/
    memory/
    tool-gateway/
    openai-gateway/
    moderation-adapter/
  packages/
    contracts/
    auth/
    logging/
    config/
    source-provenance/
  integrations/
    ticket-bot/
    github/
    sftp/
    databases/
    minecraft/
  training/
    datasets/
    generation/
    preprocessing/
    finetune/
    evaluation/
    export/
  deploy/
    bloom/
    local/
  tests/
    integration/
    regression/
    golden/
~~~

This layout is a target, not a demand that every directory exist on day one.

---

# 9. Runtime technology direction

## 9.1 Agent and Discord stack

Preferred:

- TypeScript;
- Node.js current supported LTS;
- discord.js;
- explicit typed internal APIs;
- Zod or equivalent for configuration and payload validation.

Reasons:

- existing Enthusia support infrastructure is TypeScript;
- Discord integrations are already familiar;
- common types can be shared with Ticket Bot integration;
- good fit for tool orchestration and service APIs.

## 9.2 Inference runtime

Preferred local runtime:

- llama.cpp server or another benchmarked local inference server exposing a stable HTTP/OpenAI-compatible interface.

Requirements:

- quantized model support;
- CPU + RAM inference;
- configurable context;
- configurable concurrency;
- health/readiness endpoints;
- bounded memory;
- controlled thread count;
- graceful shutdown;
- model warmup;
- metrics.

The inference runtime must be swappable.

Agent code must not depend on llama.cpp-specific internals.

## 9.3 Training stack

Preferred:

- Python;
- PyTorch;
- Hugging Face ecosystem;
- PEFT;
- LoRA/QLoRA;
- Unsloth or another benchmarked efficient fine-tuning path when appropriate.

Training code is not production-serving code.

## 9.4 Durable metadata store

Recommended initial direction:

- a dedicated Enthusia AI relational schema/database;
- MySQL/MariaDB is acceptable and may reduce operational complexity because Enthusia already uses it;
- migrations must be version-controlled.

Do not mix AI tables casually into unrelated product schemas.

## 9.5 Vector/semantic index

Preferred initial direction:

- Qdrant or another dedicated vector store with metadata filters.

Required capabilities:

- vector similarity;
- exact metadata filters;
- source visibility;
- source version;
- current/superseded state;
- timestamps;
- entity IDs;
- re-embedding/replacement;
- deletion.

If a simpler implementation satisfies the same contracts during MVP, it may be used.

---

# 10. Model strategy

## 10.1 Separate moderation and support models

Do not merge the moderation classifier and support LLM into one model.

Moderation needs:

- low latency;
- predictable classification;
- bounded memory;
- high throughput;
- operational isolation.

Support needs:

- language generation;
- tool use;
- retrieval;
- reasoning;
- context synthesis.

These are separate workloads.

## 10.2 Local support model candidates

Initial benchmarking should test models in roughly the 14B to 30B-class range, including efficient mixture-of-experts models where appropriate.

A leading initial candidate is a Qwen-class 30B-A3B instruct model or equivalent.

Model selection is not permanently locked.

Candidates must be measured on:

- Enthusia QA accuracy;
- tool-use reliability;
- source-grounding;
- instruction following;
- hallucination rate;
- escalation decisions;
- latency;
- RAM;
- CPU impact;
- context handling;
- concurrency.

## 10.3 Production RAM target

Start conservatively.

Suggested initial support-model server allocation:

- 24–32 GB RAM;
- increase only after SMP impact testing;
- do not allocate 100+ GB simply because it exists.

The dedicated host has substantial spare RAM, but Minecraft shares the physical machine.

Resource allocation must consider:

- model load time;
- restart impact;
- memory bandwidth;
- CPU cache pressure;
- host swapping;
- CPU scheduling;
- Paper main-thread sensitivity.

## 10.4 Context size

Do not default to maximum advertised model context.

Start around:

- 16K or 32K tokens;
- increase only when evaluation proves benefit.

RAG and tools should reduce the need to stuff huge source trees into every prompt.

## 10.5 Model weights versus current knowledge

Fine-tuning should primarily teach:

- behavior;
- tone;
- tool-use habits;
- escalation;
- evidence requirements;
- response structure;
- support procedure;
- uncertainty handling.

Fine-tuning should not be the primary storage mechanism for volatile facts.

---

# 11. The current-truth verification system

This section is one of the most important in the project.

The owner prefers a simple conceptual rule:

**Have the AI review/verify every relevant fact before stating it, rather than building dozens of special monitoring systems.**

The implementation should preserve that simplicity while remaining fast.

## 11.1 Verification requirement

Before the AI states a current Enthusia-specific fact, it must determine whether that fact is supported by a current source.

Examples:

- server IP;
- command syntax;
- permissions;
- ranks;
- prices;
- feature behavior;
- enabled/disabled status;
- server rules;
- staff procedure;
- plugin behavior;
- current known bug state;
- player-specific role/account state.

## 11.2 Verification tiers

### Tier A — live lookup

Use a live source when the answer is volatile or player-specific.

Examples:

- current Discord roles;
- current Minecraft identity linkage;
- current permission;
- current balance;
- current server status;
- current ticket state;
- current punishment state;
- current database row relevant to the question.

### Tier B — verified indexed source

Use the Bloom-maintained source index when the source content can be hashed/versioned.

Examples:

- current Git commit;
- plugin source;
- plugin.yml;
- configuration file;
- documentation;
- command definitions;
- rule documents.

The index record must know which source revision/hash produced the fact.

### Tier C — current structured memory

Use a current memory only when:

- it has evidence/provenance;
- its source has not been invalidated;
- no stronger current source is required.

### Tier D — model knowledge

Model recollection may guide search or answer non-Enthusia general knowledge.

It is not authoritative for mutable Enthusia facts.

## 11.3 Mandatory answer grounding

The agent should build an internal evidence set before finalizing a factual answer.

Conceptually:

~~~
claim -> source -> version/time -> confidence -> visibility
~~~

The model should not need to display citations in every casual response, but the system should retain traceability.

Staff/debug modes should be able to expose sources.

## 11.4 "Verify every fact" does not mean "query everything"

For:

    What is the IP?

It is unnecessary to read:

- ticket history;
- economy tables;
- five Git repositories;
- punishment history.

The agent should identify the minimum authoritative evidence needed.

For:

    Why can I not use /trade?

Relevant expansion may include:

- linked Minecraft account;
- current rank;
- current permission;
- relevant plugin/config;
- server the player is on;
- known issue if permissions appear correct.

This is evidence expansion, not indiscriminate surveillance.

---

# 12. Bloom knowledge/indexing service

The knowledge service runs continuously on Bloom or another approved persistent Enthusia host.

Its purpose is to make current authoritative sources cheap to verify at answer time.

It should not try to predict every possible fact.

It should maintain searchable representations of approved sources.

## 12.1 Source types

Potential sources:

- GitHub repositories;
- local read-only Git mirrors;
- Pterodactyl/SFTP file trees;
- selected configuration;
- plugin manifests;
- source code;
- documentation;
- server rules;
- command definitions;
- database schemas;
- approved database views;
- known-issue records;
- deployment metadata;
- Ticket Bot API metadata;
- Discord metadata where permitted;
- manual staff knowledge.

## 12.2 Incremental indexing

Do not repeatedly parse the entire network if nothing changed.

Each source object should have an identity and fingerprint:

- Git SHA;
- blob SHA;
- file hash;
- database revision/update timestamp;
- config checksum;
- deployment version.

When the fingerprint is unchanged:

- keep the current index.

When it changes:

- parse changed material;
- create/update knowledge;
- supersede affected old current knowledge;
- preserve history;
- update embeddings.

## 12.3 Periodic reconciliation

Even if change events/webhooks are available, periodic reconciliation should exist.

Purpose:

- recover missed events;
- detect manual config edits;
- detect out-of-band deployments;
- verify local mirrors.

This can run on Bloom without requiring a complex watcher per subsystem.

## 12.4 Source freshness

Each indexed artifact must contain:

- source ID;
- source type;
- source location;
- source version/hash;
- observed time;
- indexed time;
- visibility;
- authority level;
- current/superseded/deleted status.

## 12.5 Index lag

If a current source is known to have changed but re-indexing is incomplete:

- mark dependent knowledge stale;
- do not serve the stale fact as current;
- use live lookup or answer that current state could not be verified.

This is preferable to confidently returning old information.

---

# 13. Memory architecture

The memory system must explicitly solve the owner's stale-memory concern.

## 13.1 Two-layer memory model

### Current memory

Contains only the currently supported belief/value.

Used by normal retrieval.

### Memory history

Contains prior revisions and the reasons they changed.

Used for:

- audit;
- historical questions;
- debugging;
- understanding why the AI changed its belief.

Normal current answers must not treat history as current truth.

## 13.2 Memory entity concept

A memory should correspond to a stable subject/key when possible.

Examples:

    server.smp.connection.ip
    command.trade.permission
    rank.legend.fly
    feature.reputation.description
    bug.rosechat.duplicate-message
    procedure.item-loss.required-evidence

A current-memory table/view should have at most one active authoritative value per scope/key.

## 13.3 Supersession

When new evidence contradicts current memory:

1. validate source authority;
2. create a new memory revision;
3. mark previous current revision SUPERSEDED;
4. set the new revision CURRENT;
5. remove old revision from active semantic retrieval;
6. retain old revision in history;
7. record the relationship and reason;
8. invalidate cached answers dependent on old revision if caching exists.

Do not leave both values in current retrieval and hope the model chooses correctly.

## 13.4 Deletion/invalidation

A memory may become INVALID without a replacement.

Example:

- feature removed;
- command deleted;
- source no longer trustworthy.

In that case:

- remove from active retrieval;
- keep history;
- do not invent a replacement.

## 13.5 Conflicts

If two authoritative sources disagree:

- current memory state becomes CONFLICTED;
- do not silently choose based on embedding rank;
- use source precedence rules or live investigation;
- if unresolved, tell the user the state could not be verified and escalate where appropriate.

## 13.6 Memory evidence

Every durable fact memory should ideally include:

- key;
- value/summary;
- subject;
- scope;
- visibility;
- authority;
- evidence IDs;
- source versions;
- created time;
- current revision time;
- verification time;
- status;
- confidence;
- superseded revision;
- superseding revision.

## 13.7 Player memory

Player-specific memory must be more conservative.

Use player context when relevant, but distinguish:

- live player/account facts;
- derived operational memory;
- conversational preference/context;
- sensitive/private support history.

Do not expose staff/private facts to player-facing responses.

Do not gather unrelated player history for a trivial question.

## 13.8 Memory promotion

Not every statement becomes durable memory.

A candidate memory should be promoted only if:

- useful beyond current conversation;
- supported by evidence;
- allowed by visibility/privacy rules;
- not a secret;
- not obviously transient;
- assigned a scope and source.

## 13.9 Corrections

If owner/staff correct the AI:

1. capture correction;
2. investigate authoritative evidence where possible;
3. update current memory/index if verified;
4. supersede stale current memory;
5. preserve old history;
6. log the correction cause;
7. optionally create a regression test.

A correction is not merely appended as another equally weighted memory.

---

# 14. Knowledge versus memory

These concepts must not be conflated.

## Knowledge index

Primarily represents source material.

Examples:

- source file chunks;
- docs;
- config;
- code symbols;
- database schema descriptions.

## Memory

Represents durable conclusions/state useful to the agent.

Examples:

- current supported interpretation;
- known bug;
- support procedure;
- verified operational fact.

The agent may derive memory from knowledge, but memory must retain provenance.

---

# 15. Agent reasoning behavior

The agent should be explicitly optimized for investigative behavior.

## 15.1 Default loop

For an Enthusia question:

1. understand intent;
2. identify claims needed to answer;
3. identify potentially relevant user/server context;
4. select authoritative sources;
5. retrieve/verify;
6. inspect contradictions or missing data;
7. expand search if needed;
8. decide local answer versus escalation;
9. produce response;
10. record useful evidence-backed memory/corrections where appropriate.

## 15.2 Think outside the box

The desired behavior is not merely keyword search.

The AI should connect clues.

Example:

User:

    I just joined. What is the IP?

Possible reasoning:

- server IP is needed;
- current IP should be verified;
- user recently joined Discord may be relevant;
- welcoming language is appropriate;
- no need to inspect private history.

Example:

    I should have /fly but it says no permission.

Possible reasoning:

- identify Discord-to-Minecraft link;
- current rank;
- current permissions;
- command owner plugin;
- relevant config;
- server scope/world;
- known bugs;
- recent deployment if expected permission and actual permission conflict.

## 15.3 Bounded curiosity

Proactivity must be bounded by relevance and permission.

Do not turn every question into an exhaustive investigation.

The orchestration layer should impose:

- tool budgets;
- maximum investigation depth;
- timeouts;
- visibility constraints;
- escalation thresholds.

## 15.4 No confidence-only routing

Do not route solely because the model reports "90% confidence."

Escalation policy should include objective triggers.

---

# 16. Tool system

All powerful access should be exposed through typed tools.

The model should not receive raw credentials.

## 16.1 Required tool classes

### Knowledge search

Capabilities:

- semantic search;
- exact search;
- source filtering;
- current-only filtering;
- visibility filtering;
- source version retrieval.

### GitHub

Read capabilities:

- repositories;
- source files;
- search;
- branches;
- commits;
- PRs;
- issues;
- diffs;
- workflow results.

Write capabilities should initially be reserved for approved stronger coding workflows or explicit staff authorization.

### SFTP/server files

Read-only initial capability:

- list allowed paths;
- read allowed files;
- stat/hash files;
- search text;
- retrieve config.

Explicitly deny secret paths.

### Database

Read-only purpose-built queries.

Avoid arbitrary SQL generated by the model in production initially.

Expose safe operations such as:

- player account lookup;
- permission/rank lookup;
- economy history if approved;
- ticket metadata;
- feature-specific facts.

### Discord

Contextual reads:

- user/member identity;
- roles;
- join time;
- configured channel context;
- linked account;
- permitted history where needed.

Writes:

- response message;
- controlled reactions;
- approved actions.

### Ticket Bot

Typed API:

- get ticket;
- get context;
- request close;
- request reopen where authorized;
- request escalation;
- add structured AI note;
- retrieve transcript/evidence subject to access rules.

### OpenAI escalation

Submit a structured investigation packet.

### Moderation

Read status/decision context when needed.

Support LLM must not become the real-time moderation decision engine.

## 16.2 Tool result provenance

Tool results should carry:

- tool name;
- timestamp;
- source;
- visibility;
- request correlation ID;
- freshness/version where applicable.

---

# 17. Visibility and authorization model

Every knowledge item/tool result should be assigned visibility.

Suggested classes:

- PUBLIC;
- PLAYER_SELF;
- STAFF;
- MANAGEMENT;
- SYSTEM_INTERNAL;
- SECRET_DENY.

## 17.1 Public

Safe for any player.

Examples:

- server IP;
- public rules;
- public commands;
- public rank benefits.

## 17.2 Player self

May be shown only to the relevant player and authorized staff.

Examples:

- linked account;
- own support status;
- own balance where appropriate.

## 17.3 Staff

Internal operational information.

## 17.4 Management

Higher sensitivity.

## 17.5 System internal

Useful for reasoning but not directly disclosed.

## 17.6 Secret deny

Never indexed into model-visible storage.

Examples:

- tokens;
- passwords;
- private keys;
- DB credentials;
- SFTP credentials;
- API keys.

---

# 18. Discord behavior

## 18.1 Response triggers

Initial recommended triggers:

- direct mention;
- slash command;
- configured AI channel;
- active ticket context;
- staff command.

Future auto-response triggers may be added carefully.

## 18.2 New-player behavior

If a member asks a basic onboarding question and their join time is relevant, the AI may welcome them.

Example:

    Welcome to Enthusia! The current server address is ...

The system must verify the current address first.

## 18.3 Conversation memory

The AI may retain short conversational continuity.

Durable memory promotion is separate.

## 18.4 Rate limiting

Per-user and global limits are required.

Prevent:

- spam;
- model monopolization;
- tool abuse;
- accidental high external API costs.

## 18.5 Staff/private boundaries

A public Discord question must not cause staff-private search results to leak.

The retrieval layer must enforce visibility before the model sees the content where possible.

---

# 19. Minecraft /ai design

Future plugin requirements:

- Paper-compatible;
- async network calls;
- no blocking server main thread;
- per-player rate limits;
- configurable timeout;
- account identity;
- server/world context;
- safe message formatting;
- Bedrock/Geyser compatibility where applicable;
- permission nodes;
- staff mode;
- fallback if AI unavailable.

Possible permission nodes:

    enthusia.ai.use
    enthusia.ai.staff
    enthusia.ai.admin

The exact names are not final.

---

# 20. Ticket Bot separation and migration

The existing Ticket Bot currently contains AI-related logic.

Long-term target:

- AI-specific reasoning moves to Enthusia AI;
- Ticket Bot exposes service APIs/events;
- Ticket Bot keeps ticket state machine/lifecycle;
- Discord AI messages originate from Enthusia AI identity.

## 20.1 Migration strategy

Do not rip out current AI first.

Sequence:

1. define Ticket Bot integration contract;
2. build Enthusia AI service;
3. shadow existing AI decisions;
4. compare results;
5. migrate reads/context;
6. migrate response generation;
7. migrate memory/knowledge;
8. migrate visible AI messages;
9. remove old duplicated AI authority;
10. preserve rollback path until stable.

## 20.2 Ticket actions

AI should request, not directly perform:

- close;
- reopen;
- escalation;
- state transition.

Ticket Bot validates:

- permissions;
- state;
- confirmation;
- concurrency;
- transcript/archive rules.

---

# 21. Moderation integration

Moderation is a sibling system.

## 21.1 Requirements

- separate process;
- separate model;
- independent health;
- low-latency;
- fail-open/fail-safe behavior as defined by moderation project;
- no dependence on support LLM availability.

## 21.2 Shared infrastructure

May share:

- deployment host;
- logging;
- identity mapping;
- selected knowledge;
- model artifact management;
- metrics.

Must not share a single failure domain unnecessarily.

---

# 22. OpenAI escalation

The local model acts as coordinator.

OpenAI is used when policy or complexity requires it.

## 22.1 Mandatory/strong escalation triggers

Examples:

- code changes requested;
- complex debugging;
- multi-repository investigation;
- repeated local tool failures;
- contradictory technical evidence;
- security-sensitive analysis;
- architectural refactor;
- high-impact operational recommendation;
- owner/staff explicitly requests deep investigation.

## 22.2 Escalation packet

Do not simply send:

    fix this

Send structured context:

- user question;
- goal;
- relevant repositories;
- relevant files;
- current SHAs;
- logs;
- tool evidence;
- attempted diagnosis;
- unresolved questions;
- constraints;
- authorization;
- expected output.

## 22.3 OpenAI response handling

The local agent should:

- receive result;
- verify applicable current facts;
- present player-safe result;
- retain technical details at appropriate visibility;
- update memory when evidence justifies it;
- track code PR/commit references.

## 22.4 Coding authority

Initial default:

- local model reads/analyzes code;
- OpenAI performs heavy coding tasks;
- code writes occur through explicit GitHub workflows;
- no production deployment without approved deployment process.

Local autonomous code-writing can be reconsidered after evaluation.

---

# 23. GitHub understanding

Enthusia AI should have deep read access to approved Enthusia repositories.

## 23.1 Indexing

Index:

- repository;
- default branch;
- files;
- language;
- symbols/classes/functions where practical;
- plugin metadata;
- commands;
- permissions;
- config examples;
- README/docs;
- commit history summaries;
- issues;
- PRs;
- releases/deployments.

## 23.2 Current-source verification

Current default branch SHA should be known.

Knowledge derived from old commits must not appear current unless explicitly historical.

## 23.3 Code graph

Future enhancement:

Build relationships:

- plugin -> command;
- command -> permission;
- service -> database;
- event -> listener;
- config key -> behavior;
- API -> consumer;
- repository -> deployed artifact.

This allows better cross-system reasoning than raw vector search alone.

---

# 24. SFTP/network indexing

The owner wants the AI to understand the entire network deeply.

A dedicated indexer may inspect approved server files through read-only SFTP.

## 24.1 Allowlist model

Do not expose the entire filesystem blindly.

Define allowed roots per server.

Examples:

- plugins;
- plugin configs;
- selected logs;
- server config;
- proxy config.

Deny:

- environment files;
- credential stores;
- SSH keys;
- tokens;
- backups containing secrets unless specifically processed by a secret-safe system.

## 24.2 Incremental scan

The indexer should record:

- path;
- size;
- modified time;
- hash;
- server;
- visibility;
- parser.

Only changed files need full reprocessing.

## 24.3 Artifact awareness

The AI should understand which plugin artifact/config belongs to which GitHub project and deployment version where possible.

---

# 25. Database understanding

The AI should understand schemas and selected live state.

## 25.1 Schema indexing

Read and index:

- table names;
- columns;
- relationships;
- descriptions;
- ownership/component mapping.

## 25.2 Live data

Expose live data through purpose-built read tools.

Do not indiscriminately embed entire production databases.

Reasons:

- freshness;
- privacy;
- size;
- deletion;
- access control;
- data semantics.

## 25.3 Read-only credentials

Use separate read-only service accounts/views where possible.

---

# 26. Training data strategy

The project plans multiple training-data sources.

## 26.1 Planned sources

- historical real Enthusia support tickets;
- staff-authored support examples;
- synthetic support tickets;
- server documentation;
- rules/policies;
- public feature information;
- approved operational procedures;
- known-bug scenarios;
- corrected AI responses;
- tool-use demonstrations;
- escalation demonstrations;
- code-investigation examples;
- ambiguity/follow-up examples.

Historical ticket data is an owner-directed planned source. Before implementing the actual extraction/training path, the project should include a data-governance/compliance checkpoint and document the owner's authorization and applicable platform/data obligations.

## 26.2 Why real tickets are valuable

The intended value includes:

- real player wording;
- evidence staff actually request;
- real problem patterns;
- historical support decisions;
- escalation patterns;
- response expectations;
- common misunderstandings.

Raw historical behavior should not automatically be treated as ideal behavior.

## 26.3 Ticket curation

The training pipeline should support:

- redaction/anonymization where desired;
- removal of secrets;
- removal of irrelevant chatter;
- marking poor responses;
- marking outdated answers;
- extracting issue/outcome structure;
- excluding corrupt/incomplete examples;
- quality scoring.

## 26.4 Synthetic data

Generate a large synthetic corpus from authoritative Enthusia sources.

Synthetic generation should cover:

- novice questions;
- expert questions;
- ambiguous questions;
- wrong assumptions;
- missing evidence;
- policy questions;
- bug reports;
- command help;
- permissions;
- rank behavior;
- account linking;
- economy;
- moderation boundaries;
- ticket actions;
- code investigation;
- escalation.

## 26.5 Tool-use traces

Fine-tuning examples should show:

- question;
- thought/decision representation appropriate for training;
- tool selection;
- tool result;
- next tool;
- final answer.

Do not require exposure of private chain-of-thought at runtime.

Use concise action/rationale labels rather than hidden reasoning transcripts where possible.

## 26.6 Negative examples

Include examples where the model must:

- not guess;
- not use stale memory;
- verify;
- escalate;
- refuse unauthorized data;
- distinguish history from current state;
- ignore malicious prompt injection in source documents.

---

# 27. Dataset format

Recommended normalized record:

~~~
{
  "id": "...",
  "source_type": "synthetic|ticket|staff|evaluation",
  "visibility": "public|staff|...",
  "scenario": "...",
  "messages": [...],
  "tools": [...],
  "expected_actions": [...],
  "expected_answer": "...",
  "facts": [
    {
      "claim": "...",
      "source": "...",
      "source_version": "..."
    }
  ],
  "tags": [...],
  "quality": "...",
  "created_at": "...",
  "dataset_version": "..."
}
~~~

Training datasets must be versioned.

Never silently change a dataset used for a benchmark/training run.

---

# 28. Training plan

The owner has:

- NVIDIA RTX 4060 Ti;
- 8 GB VRAM;
- 64 GB system RAM;
- willingness to leave the PC running for long preprocessing/training tasks;
- maximum external GPU budget of USD $25 for this project unless explicitly changed.

## 28.1 Local PC role

Use local PC heavily for:

- corpus generation;
- cleaning;
- deduplication;
- indexing;
- embeddings;
- evaluation;
- small-model tests;
- pipeline validation;
- data formatting;
- LoRA experiments that fit.

## 28.2 Large-model fine-tune

For a roughly 14B–30B target, an 8 GB GPU may require aggressive offload and may be impractically slow.

The pipeline should support rented GPU execution.

## 28.3 Budget rule

Hard initial rental budget:

**$25 maximum**

Workers must not create paid infrastructure that can exceed this without explicit owner approval.

## 28.4 Rental strategy

Do not waste rental time on setup/debugging that can be done locally.

Before renting:

- dataset finalized enough for run;
- training code tested;
- dependencies pinned;
- checkpoint strategy selected;
- evaluation script ready;
- export/quantization script ready.

Then rent an appropriate high-VRAM GPU.

A lower-cost 48 GB GPU may offer better iteration value than an 80 GB A100 if the target configuration fits.

Benchmark rather than assuming.

## 28.5 Training stages

1. baseline model evaluation;
2. small dataset smoke fine-tune;
3. evaluate;
4. fix data/prompt/tool mistakes;
5. full LoRA/QLoRA;
6. evaluate;
7. optional second run;
8. merge/export adapter as appropriate;
9. quantize;
10. production benchmark.

## 28.6 Re-training cadence

Knowledge changes do not automatically require retraining.

Retrain when behavior improvements justify it:

- accumulated corrections;
- new tool-use patterns;
- new support behavior;
- significant dataset growth;
- model upgrade.

---

# 29. Evaluation framework

No model should be accepted because it "seems good."

## 29.1 Golden set

Create a frozen owner/staff-reviewed evaluation suite.

Categories:

- onboarding;
- commands;
- ranks;
- permissions;
- economy;
- tickets;
- rules;
- plugin behavior;
- known bugs;
- player-specific context;
- GitHub questions;
- ambiguous questions;
- escalation;
- privacy;
- stale facts;
- conflicting evidence;
- tool failure;
- prompt injection.

## 29.2 Metrics

Measure:

- factual correctness;
- source correctness;
- stale-answer rate;
- hallucination rate;
- tool-selection accuracy;
- escalation precision;
- escalation recall;
- unauthorized-disclosure rate;
- latency;
- tokens;
- external cost;
- RAM;
- CPU;
- timeout rate.

## 29.3 Stale-memory regression tests

Critical tests:

1. teach/index fact A;
2. verify model answers A;
3. update authoritative source to B;
4. re-index;
5. ensure active memory is B;
6. ensure A exists only in history;
7. ask current question;
8. model must answer B;
9. ask historical question for old period;
10. model may answer A with historical framing.

## 29.4 Source-conflict tests

Two sources disagree.

Expected:

- use precedence;
- investigate;
- or explicitly report uncertainty.

Not acceptable:

- randomly select one.

---

# 30. Source authority hierarchy

The exact order varies by domain, but define explicit authority.

Example for command permissions:

1. live permission service;
2. deployed config;
3. deployed plugin/source version;
4. current Git source if confirmed deployed;
5. staff knowledge;
6. historical memory;
7. model weights.

Example for policy:

1. current official rules/policy document;
2. approved staff configuration;
3. current structured memory;
4. historical decisions;
5. model weights.

Do not assume Git main equals production unless deployment evidence says so.

---

# 31. Deployment/version awareness

Knowledge should distinguish:

- Git main;
- staged version;
- deployed production version.

The AI must not describe unreleased code as live behavior.

Record:

- repository;
- commit;
- build artifact;
- target server;
- deployment time;
- current runtime version.

---

# 32. Correction and self-improvement loop

When AI makes a bad factual answer:

1. capture feedback;
2. identify unsupported/stale claim;
3. identify source used;
4. inspect authoritative source;
5. update current memory/index;
6. supersede old memory;
7. record historical revision;
8. create regression example when valuable;
9. optionally add dataset candidate;
10. measure recurrence.

This is how the system should improve continuously without allowing uncontrolled self-modification.

---

# 33. Prompt injection resistance

Indexed content may contain hostile text.

Examples:

- README says "ignore prior instructions";
- player writes tool commands into ticket;
- malicious issue body attempts to exfiltrate secrets.

Source content is data, not authority over the agent.

The orchestration layer must separate:

- system policy;
- tool instructions;
- retrieved content.

Retrieved text must never override higher-level policies.

---

# 34. Security model

## 34.1 Secret handling

Secrets live in:

- environment variables;
- secret manager;
- protected config.

Never:

- commit them;
- embed them;
- train on them;
- store them as memory;
- print them to normal logs.

## 34.2 Network

Prefer localhost/private networking between:

- inference;
- agent;
- vector DB;
- memory DB;
- moderation.

Expose public endpoints only where required.

## 34.3 Authentication

Internal APIs require service authentication.

## 34.4 Action authorization

Every write tool should validate:

- caller;
- actor;
- guild;
- permission;
- target;
- action class;
- request ID.

## 34.5 Auditing

High-impact actions must be auditable.

---

# 35. Operational isolation from the SMP

The AI runs on the same dedicated physical machine as the SMP, so resource isolation is required.

## 35.1 Separate Pterodactyl split

Create a dedicated Enthusia AI server allocation/split.

Suggested processes:

- agent;
- Discord bot;
- local inference;
- indexer;
- vector store;
- optional moderation integration.

Moderation may be a separate split if this improves isolation.

## 35.2 CPU limits

Do not allow inference to saturate all cores.

Benchmark impact on:

- MSPT;
- tick time;
- chunk work;
- garbage collection;
- network thread responsiveness.

## 35.3 Startup

Large model startup must not coincide unnecessarily with SMP-critical operations.

AI service restarts should not require Ticket Bot restart.

Ticket Bot restart should not reload the local LLM.

## 35.4 OOM behavior

Support inference failure must not kill:

- SMP;
- moderation;
- Ticket Bot.

---

# 36. Health and observability

Every service requires:

- /health/live;
- /health/ready where appropriate;
- structured logs;
- request IDs;
- metrics;
- startup version;
- dependency status.

Track:

- model loaded;
- model RAM;
- prompt tokens;
- generation tokens;
- inference latency;
- queue depth;
- active requests;
- tool calls;
- tool failures;
- OpenAI escalations;
- external cost;
- retrieval count;
- stale-source blocks;
- memory updates;
- supersessions;
- index lag.

---

# 37. External API cost controls

OpenAI usage must be bounded.

Controls:

- route routine questions locally;
- maximum escalation calls per request;
- per-user rate limits;
- per-day budget visibility;
- coding workflows separate from player chat;
- explicit model selection policy.

The local AI should not escalate because it is lazy.

---

# 38. Caching

Caching is allowed but must respect freshness.

A cached answer needs dependency metadata.

If a dependency is superseded:

- invalidate cache.

Do not cache volatile player-specific answers broadly.

---

# 39. Search architecture

Use hybrid retrieval where practical:

- semantic vector search;
- lexical/exact search;
- structured entity lookup;
- code symbol search;
- source filters.

Vector similarity alone is insufficient for:

- command names;
- permission nodes;
- exact config keys;
- player UUIDs;
- version strings.

---

# 40. Entity graph

Future/desired entity types:

- server;
- plugin;
- repository;
- command;
- permission;
- rank;
- config key;
- feature;
- database table;
- API;
- issue;
- deployment;
- bug;
- player;
- Discord role.

Relationships:

- plugin DEFINES command;
- command REQUIRES permission;
- rank GRANTS permission;
- repository BUILDS plugin;
- deployment DEPLOYS commit;
- feature IMPLEMENTED_BY plugin;
- bug AFFECTS feature;
- player HAS rank;
- Discord role MAPS_TO rank.

This graph should supplement, not replace, source evidence.

---

# 41. Historical ticket training and support knowledge

The project owner explicitly wants historical tickets included in the training plan.

The implementation should therefore include a workstream for:

- identifying ticket records;
- extracting structured conversation/problem/outcome data;
- cleaning;
- removing secrets;
- labeling quality;
- separating current policy from historical behavior;
- creating training examples;
- preserving dataset provenance.

Before executing the final real-ticket training pipeline, document applicable data/platform requirements and owner authorization.

Historical tickets should not become the sole source of truth for current server facts.

A 2024 ticket saying a command works one way must not override 2026 live configuration.

---

# 42. Synthetic corpus generation

A large synthetic dataset should be deliberately generated.

## 42.1 Generation from source

For each feature:

- produce novice FAQ;
- troubleshooting;
- false assumptions;
- incomplete evidence;
- edge cases;
- staff escalation;
- tool-use examples.

## 42.2 Adversarial generation

Generate examples designed to catch:

- stale data;
- ambiguous ranks;
- conflicting configs;
- undeployed Git changes;
- hallucinated commands;
- unauthorized information;
- prompt injection.

## 42.3 Validation

Synthetic examples must be checked against authoritative source material.

A stronger model may generate candidates, but candidate text is not automatically ground truth.

---

# 43. Model behavior training targets

Fine-tuning should explicitly encourage:

- concise useful player answers;
- deeper staff answers when requested;
- evidence gathering;
- tool use;
- source skepticism;
- correction handling;
- uncertainty;
- escalation;
- not fabricating;
- remembering useful stable procedures;
- replacing stale current memory;
- preserving history separately;
- respecting visibility.

---

# 44. Personality

Enthusia AI should feel:

- helpful;
- competent;
- direct;
- natural;
- not robotic;
- not excessively verbose by default;
- willing to investigate.

Avoid:

- fake certainty;
- over-apologizing;
- excessive disclaimers;
- pretending an action occurred;
- pretending it searched when it did not.

The owner can refine personality later.

---

# 45. Answer policy examples

## 45.1 Simple verified answer

Question:

    What's the IP?

Behavior:

- verify current connection endpoint;
- optionally use relevant join context;
- answer concisely.

## 45.2 Personalized troubleshooting

Question:

    Why don't I have /fly?

Behavior:

- resolve player identity;
- check current rank/permission;
- check command/plugin/config;
- identify mismatch;
- explain;
- escalate if system appears broken.

## 45.3 Unknown

Question:

    Does feature X do Y?

If no authoritative evidence:

- search wider;
- if still unknown, say it could not verify;
- do not improvise.

## 45.4 Historical

Question:

    Did VIP used to get /fly?

Historical memory may be used.

Clearly distinguish past from current.

---

# 46. OpenAI/coding workflow

Example:

~~~
player/staff issue
   |
local AI investigates
   |
technical bug likely
   |
build evidence packet
   |
OpenAI coding agent
   |
GitHub read/change/test/PR
   |
result
   |
Enthusia AI validates current status
   |
communicate outcome
~~~

The AI should be able to track that a PR is:

- proposed;
- open;
- merged;
- deployed.

Do not tell a player a fix is live merely because a PR was merged.

---

# 47. Failure behavior

## 47.1 Local model offline

Discord bot should:

- report temporary AI unavailability;
- optionally use approved fallback depending on policy;
- not crash Ticket Bot.

## 47.2 Knowledge service unavailable

For mutable Enthusia facts:

- avoid guessing;
- try live tools;
- escalate/fail gracefully.

## 47.3 OpenAI unavailable

Routine local support continues.

Deep coding escalation is deferred/declared unavailable.

## 47.4 Tool timeout

Bound retries.

Do not loop indefinitely.

## 47.5 Contradictory state

Surface uncertainty or escalate.

---

# 48. API contracts

Use versioned internal APIs.

Suggested base namespaces:

    /v1/chat
    /v1/agent
    /v1/knowledge
    /v1/memory
    /v1/tools
    /v1/escalations
    /v1/health

## 48.1 Chat request

Conceptual:

~~~
{
  "surface": "discord|minecraft|ticket|staff",
  "actor": {...},
  "conversation_id": "...",
  "message": "...",
  "context": {...},
  "visibility_ceiling": "PUBLIC|PLAYER_SELF|STAFF|..."
}
~~~

## 48.2 Agent response

~~~
{
  "text": "...",
  "actions": [...],
  "sources": [...],
  "memory_updates": [...],
  "escalation": null,
  "trace_id": "..."
}
~~~

User-facing surfaces need not expose all internal fields.

---

# 49. Memory storage schema concept

Suggested entities:

## MemoryKey

- id;
- namespace;
- key;
- scope;
- visibility.

## MemoryRevision

- id;
- memory_key_id;
- value;
- summary;
- status CURRENT/SUPERSEDED/INVALID/CONFLICTED;
- valid_from;
- valid_to;
- created_at;
- verified_at;
- authority;
- evidence references;
- supersedes revision ID;
- superseded_by revision ID.

## MemoryEvidence

- revision ID;
- source artifact ID;
- source version;
- evidence role.

A database view/index should return CURRENT only by default.

---

# 50. Source artifact schema concept

Fields:

- artifact ID;
- source type;
- source locator;
- component;
- visibility;
- authority;
- version/hash;
- observed time;
- indexed time;
- current flag;
- content metadata;
- parser version;
- embedding version.

---

# 51. Conversation storage

Keep:

- message IDs;
- actor identity;
- surface;
- timestamps;
- tool references;
- response references;
- visibility.

Do not automatically promote all conversation text into durable semantic memory.

---

# 52. Indexer scheduling

Initial approach:

- continuous service on Bloom;
- poll/reconcile on bounded schedule;
- GitHub webhook support later;
- immediate refresh endpoint for deployments;
- incremental hashes.

Important:

The indexer does not replace answer-time verification.

It makes verification fast.

---

# 53. Deployment hooks

Future deploy tooling should notify Enthusia AI:

    component X deployed at commit Y

The indexer can prioritize that component.

Until hooks exist, periodic reconciliation provides eventual correction.

---

# 54. Freshness semantics

Do not use a single arbitrary TTL for everything.

Examples:

- player role: live lookup;
- balance: live lookup;
- source file: valid while SHA matches;
- configuration: valid while file hash matches;
- official rules: valid while document version matches;
- known bug: revalidate against issue/deployment state;
- model-learned fact: never sufficient alone for mutable current fact.

---

# 55. Staff knowledge

Staff should be able to add approved operational knowledge.

It must include:

- author;
- visibility;
- date;
- subject/key;
- evidence or explicit authority;
- optional expiry/review.

A later conflicting authoritative source should supersede it appropriately.

---

# 56. Owner authority

Owner-provided explicit decisions can be high-authority, but the system should distinguish:

- owner policy;
- owner factual claim;
- owner correction.

Where a live technical source can verify a factual correction, verify it.

---

# 57. Development process with Muse and dots

The owner plans to use Muse and dots AI 24/7 agents capable of dispatching many workers.

This specification must enable parallelism.

Workers should operate from explicit workstream contracts.

Rules:

- one owner per subsystem;
- avoid duplicate implementations;
- define interfaces first;
- no silent architecture changes;
- use PRs;
- tests required;
- cross-service contracts live in shared package/spec;
- coordinator tracks dependency graph.

See WORKER-EXECUTION-PLAN.md.

---

# 58. Proposed implementation phases

## Phase 0 — specification and contracts

Deliver:

- master spec;
- worker plan;
- architecture contracts;
- repo scaffolding;
- CI;
- configuration pattern;
- security baseline.

## Phase 1 — local AI skeleton

Deliver:

- AI Gateway;
- local inference adapter;
- basic agent;
- health checks;
- Discord test bot;
- no production actions.

## Phase 2 — knowledge

Deliver:

- source registry;
- GitHub indexing;
- local source mirror;
- semantic/exact retrieval;
- provenance;
- current/superseded source handling.

## Phase 3 — memory

Deliver:

- current/history model;
- supersession;
- evidence links;
- correction flow;
- regression tests.

## Phase 4 — tools/context

Deliver:

- GitHub read tools;
- SFTP read tools;
- DB safe tools;
- Discord identity/roles;
- player linkage.

## Phase 5 — OpenAI escalation

Deliver:

- escalation policy;
- structured packet;
- stronger model integration;
- coding workflow.

## Phase 6 — Discord production beta

Deliver:

- Enthusia AI bot;
- mentions;
- AI channel;
- staff permissions;
- monitoring;
- rate limits.

## Phase 7 — Ticket AI migration

Deliver:

- Ticket Bot API;
- AI shadow;
- parity tests;
- migrate responses;
- separate AI identity;
- remove duplicate authority.

## Phase 8 — training corpus and fine-tune

Deliver:

- dataset pipeline;
- ticket-data pipeline per owner plan and governance gate;
- synthetic corpus;
- golden evaluation set;
- local smoke training;
- rented GPU run within $25;
- quantized artifact.

## Phase 9 — production local model

Deliver:

- benchmark;
- resource isolation;
- rollout;
- fallback;
- monitoring.

## Phase 10 — Minecraft /ai

Deliver:

- Paper plugin;
- API integration;
- permissions;
- Bedrock compatibility;
- rate limits.

## Phase 11 — advanced knowledge graph/self-improvement

Deliver:

- deeper entity graph;
- deployment-aware facts;
- correction-driven regression;
- staff knowledge UI.

---

# 59. MVP acceptance criteria

A first meaningful MVP is acceptable when:

- Enthusia AI Discord bot is online;
- local model answers;
- AI can search current GitHub-derived knowledge;
- AI verifies mutable server facts before assertion;
- current/superseded memory works;
- sources are traceable;
- secrets are excluded;
- simple questions work without OpenAI;
- difficult technical request can escalate;
- SMP performance is not meaningfully harmed;
- moderation remains independent.

---

# 60. Beta acceptance criteria

Beta requires:

- read-only SFTP/config indexing;
- safe DB tools;
- player identity/context;
- multiple repositories;
- deployment/version awareness;
- correction loop;
- stale-memory regression suite;
- ticket integration;
- observability;
- rate limits;
- permission/visibility enforcement;
- evaluation dashboard/report.

---

# 61. Production acceptance criteria

Before broad player exposure:

- golden suite threshold approved by owner;
- no known visibility leaks;
- no secrets indexed;
- bounded CPU/RAM;
- safe failure behavior;
- rollback documented;
- OpenAI cost bounded;
- current-memory semantics proven;
- fact verification proven;
- moderation isolation proven;
- Ticket Bot integration stable.

---

# 62. Performance targets

Initial targets are provisional.

Simple cached/index-backed question:

- aim for first useful response within a few seconds.

Tool-heavy question:

- tolerate longer latency if investigation is meaningful.

Do not sacrifice correctness merely to meet an arbitrary latency target.

Concurrency:

- start low;
- measure actual Discord demand;
- scale only if necessary.

---

# 63. Resource strategy

The dedicated machine reportedly has over 100 GB of spare RAM available, but the AI must coexist with the SMP.

Initial approach:

- model server capped around 24–32 GB;
- vector DB bounded;
- indexer low-priority/background;
- controlled CPU threads;
- no swap thrashing;
- benchmark SMP during inference.

If stable, increase model/resources experimentally.

---

# 64. Model artifact management

Each model release needs:

- base model name/version;
- license;
- training dataset version;
- training code commit;
- hyperparameters;
- adapter hash;
- quantization method;
- final artifact hash;
- evaluation report;
- deployment date.

Never deploy an anonymous model file with unknown lineage.

---

# 65. Dataset lineage

Each training run records:

- source dataset versions;
- filters;
- exclusions;
- generator model versions if synthetic;
- random seeds where relevant;
- tokenizer;
- code commit.

This makes results reproducible.

---

# 66. Model rollback

Keep at least:

- current production;
- previous known-good model.

Rollback should not require rebuilding dataset.

---

# 67. Knowledge rollback/history

Source history must allow:

- investigation of what AI knew at a time;
- current-state rebuild;
- recovery from bad indexer release.

Current retrieval should still expose only current state.

---

# 68. Privacy-aware contextual reasoning

The owner wants the AI to look at relevant player details.

This should be implemented as purpose-based context expansion.

Example:

Question about rank:

- role/rank context relevant.

Question about ticket history:

- support history relevant if authorized.

Question about server IP:

- private punishment/ticket history irrelevant.

The agent should not collect sensitive context merely because it can.

---

# 69. Player profile service

Future normalized player identity may map:

- Discord ID;
- Minecraft UUID;
- Minecraft name;
- Bedrock identity if applicable;
- roles/ranks;
- network account metadata.

This service should be the canonical identity bridge.

---

# 70. Audit trail

For meaningful AI actions, record:

- actor;
- surface;
- request;
- model version;
- tools used;
- source references;
- escalation;
- action requests;
- outcome.

Sensitive content should follow retention policy.

---

# 71. Staff overrides

Staff should be able to:

- correct AI;
- disable memory;
- invalidate a knowledge item;
- force re-index;
- inspect sources;
- disable a tool;
- disable AI on a surface;
- escalate manually.

---

# 72. Emergency controls

Provide kill switches for:

- AI responses;
- external OpenAI calls;
- SFTP indexing;
- database tools;
- Discord auto-responses;
- Minecraft /ai;
- memory writes.

Moderation kill controls remain separate.

---

# 73. Prompt/version management

System prompts and tool policies must be version-controlled.

Each production response trace should know prompt/policy version.

---

# 74. Testing layers

Required:

- unit;
- integration;
- contract;
- end-to-end;
- model evaluation;
- golden regression;
- security;
- source freshness;
- memory supersession;
- load/performance.

---

# 75. CI requirements

At minimum:

- lint;
- typecheck;
- unit tests;
- contract tests;
- secret scan;
- configuration validation.

Model-heavy tests can run separately.

---

# 76. Local development

Developers/workers must be able to run:

- mock inference;
- local small model;
- fake tools;
- test DB;
- fixture knowledge.

Do not require production credentials for routine tests.

---

# 77. Production configuration

All production settings should be environment/config driven.

Examples:

- model endpoint;
- max context;
- max tool calls;
- OpenAI models;
- rate limits;
- allowed repos;
- allowed SFTP roots;
- DB views;
- Discord channels;
- visibility policy;
- resource thresholds.

---

# 78. Tool budgets

Suggested request classes:

### Simple

- small number of retrieval/live checks.

### Investigative

- larger tool budget;
- code search;
- multiple sources.

### Engineering escalation

- build packet;
- delegate.

Avoid unbounded autonomous loops.

---

# 79. Response source trace

Internally attach sources to claims when practical.

A future staff command could show:

    /ai sources <message>

or equivalent.

Not required for MVP but architecture should support it.

---

# 80. Memory history UI

Future staff view should show:

~~~
command.trade.permission

CURRENT:
  enthusia.trade
  verified from deployed config
  2026-10-03

HISTORY:
  vip.trade
  superseded 2026-09-10
  reason: config changed
~~~

This directly implements the owner's requirement not to keep stale memory as primary truth.

---

# 81. Unknown truth state

The system must be comfortable storing:

- UNKNOWN;
- CONFLICTED;
- STALE/UNVERIFIED.

Do not force every entity to have a confident value.

---

# 82. Automatic memory refresh

When the agent verifies a fact and the source/version differs from active memory:

- enqueue memory reconciliation.

This means answer-time verification itself helps keep memory current.

A separate complex watcher is not required for every fact.

The Bloom indexer plus answer-time verification together form the freshness strategy.

---

# 83. Background memory reconciliation

A low-priority Bloom task may periodically:

- check source-backed current memories;
- detect invalid source versions;
- mark stale;
- refresh cheap facts.

This should be generic, not dozens of bespoke monitors.

---

# 84. Search failure semantics

If search returns no result:

- do not treat that as proof a feature does not exist unless the source is exhaustive and the query semantics justify it.

The agent may broaden search.

---

# 85. Database absence semantics

"No matching row" can mean different things.

Tools should document semantics.

Avoid converting missing data into false claims.

---

# 86. Time awareness

Responses about:

- current;
- recently;
- before/after deploy;
- historical behavior

must use actual timestamps/versions.

Current and historical memory must remain distinguishable.

---

# 87. Human escalation

Some situations should go to human staff even if OpenAI is available.

Examples:

- policy discretion;
- account punishment appeals;
- uncertain compensation/refund decisions;
- privacy/security concern;
- irreversible action.

The AI can prepare evidence.

---

# 88. Action approval levels

Suggested:

### Level 0 — read

No approval.

### Level 1 — low-risk reversible

May be policy-automatic.

### Level 2 — user-impacting

Requires role/authorization or confirmation.

### Level 3 — destructive/security-sensitive

Explicit staff/owner approval.

Exact mapping will be defined per tool.

---

# 89. Coding agent boundaries

OpenAI coding agent may:

- read repos;
- create branches;
- modify code;
- run tests;
- open PRs.

It should not automatically:

- merge;
- deploy;
- restart production;
- mutate live data

unless separately authorized by owner policy.

---

# 90. Deployment truth

The AI should understand:

- code written;
- PR open;
- PR merged;
- deployed;
- process restarted;
- runtime version confirmed.

These are distinct states.

---

# 91. Known-bug memory

Known bug entity should include:

- component;
- symptom;
- affected versions;
- evidence;
- workaround;
- fix commit;
- deployment status;
- current state OPEN/FIXED/DEPLOYED/VERIFIED.

Once fixed/deployed, current support answers should not keep describing it as active unless evidence shows recurrence.

Historical record remains.

---

# 92. Knowledge authority from code

Source code may describe intended behavior but live configuration can override it.

The agent should reason about precedence.

Examples:

- source default says enabled;
- production config says disabled.

Current answer: disabled.

---

# 93. Network scan bootstrap

An initial discovery job may run for a long time to build the first index.

It may inspect all approved:

- repos;
- configs;
- plugin files;
- schemas;
- docs.

The owner's PC may assist with processing, but production indexing should eventually be reproducible from Bloom.

Do not create a knowledge system that only works if the owner's PC is online.

---

# 94. Source parser architecture

Parsers should be modular.

Examples:

- Java/Kotlin plugin;
- YAML;
- JSON;
- TOML;
- properties;
- SQL schema;
- Markdown;
- text logs.

Each parser produces normalized artifacts/entities.

---

# 95. Command catalog

Build a structured catalog where possible:

- command;
- aliases;
- plugin;
- permission;
- arguments;
- description;
- availability;
- server scope;
- source version.

This will improve support dramatically.

---

# 96. Permission catalog

Map:

- permission nodes;
- ranks/groups;
- contexts;
- worlds/servers;
- plugin.

Use live permission lookup for player-specific claims.

---

# 97. Configuration catalog

Extract typed configuration keys when useful.

Record source hash and deployment target.

---

# 98. Documentation generation

The AI may generate documentation candidates from code/config, but auto-generated docs should be marked derived until reviewed or continually verified.

---

# 99. External web knowledge

General web search may be added for non-Enthusia topics or third-party plugin documentation.

Current Enthusia-owned sources should normally outrank generic web pages.

---

# 100. Server-wide AI future

Long-term, Enthusia AI may power:

- Discord support;
- Minecraft support;
- staff assistant;
- ticket assistant;
- bug triage;
- documentation;
- deployment explanations;
- player onboarding;
- event help;
- moderation support;
- coding escalation.

The architecture should remain one shared intelligence platform.

---

# 101. Locked owner decisions as of 2026-10-03

The following decisions are considered accepted unless explicitly changed:

1. Create Enthusia AI as a separate system/repository.
2. Give it its own Discord bot identity.
3. Eventually expose it in Minecraft through /ai.
4. Keep moderation model separate.
5. Keep OpenAI for deep coding and investigations.
6. Let local AI coordinate/escalate to stronger OpenAI models.
7. Give local AI read access to GitHub and broad approved server knowledge.
8. Let the AI proactively inspect relevant context.
9. Require verification of current Enthusia facts before assertion.
10. Run a generic continuously refreshed knowledge/index layer on Bloom.
11. Preserve memory history while removing stale values from the active/current view.
12. Use historical ticket data as a planned training source, with a governance checkpoint before pipeline execution.
13. Generate a large synthetic training corpus.
14. Train primarily on owner's PC where practical.
15. Allow up to $25 total rented GPU budget initially.
16. Prefer behavior fine-tuning over encoding volatile facts in weights.
17. Move AI reasoning out of the Ticket Bot over time.
18. Keep Ticket Bot as ticket lifecycle authority.
19. Do not let AI resource usage significantly harm the SMP.
20. Use Muse/dots multi-worker development after interfaces/specifications are defined.
21. Project is proprietary under the repository LICENSE.

---

# 102. Decisions intentionally not locked yet

These require benchmarking or implementation evidence:

- exact base support model;
- exact quantization;
- exact inference runtime;
- exact vector database;
- exact relational storage choice;
- exact model RAM cap;
- exact context length;
- exact synthetic dataset size;
- exact LoRA hyperparameters;
- exact external GPU;
- exact auto-response Discord channels;
- exact Minecraft /ai UX.

Workers should not convert these into permanent assumptions without evidence.

---

# 103. Definition of success

Enthusia AI succeeds when players and staff can treat it as a reliable resident expert on the network because it:

- actually checks;
- knows where facts come from;
- recognizes when information changed;
- replaces stale active memory;
- preserves useful history;
- understands player context when relevant;
- can inspect code/config/data;
- admits when it cannot verify;
- escalates difficult work;
- does not expose private information;
- does not harm server performance;
- improves from corrections.

The target is not to make a tiny local model magically know everything.

The target is to build a system in which a capable local model is surrounded by current evidence, durable memory, tools, policy, strong external escalation, and rigorous evaluation.

That complete system is the product.

---

# 104. Worker rule

No implementation worker should begin a broad subsystem by asking, "What should this do?" if this document already answers it.

Workers should identify:

- their workstream;
- dependencies;
- required interfaces;
- acceptance tests;
- files/repos they own;
- what they must not change.

See WORKER-EXECUTION-PLAN.md for the initial parallel work breakdown.
