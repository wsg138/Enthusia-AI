# Enthusia AI — Memory, Knowledge, and Fact Verification Contract

**Authority:** Sub-specification of docs/MASTER-SPECIFICATION.md  
**Purpose:** Define exact semantics for current truth, history, supersession, retrieval, verification, and corrections.

---

# 1. Primary invariant

Enthusia AI must never keep a known-stale value as part of its normal current knowledge simply because that value existed before.

When current truth changes:

- update current state;
- remove stale state from normal current retrieval;
- preserve stale state only as history;
- retain provenance explaining the transition.

History is not deleted merely because current truth changed.

Current retrieval and historical retrieval are distinct operations.

---

# 2. Storage model

Use three conceptual layers.

## 2.1 Source artifacts

Raw/parsed evidence.

Examples:

- Git file at SHA;
- deployed config at hash;
- permission lookup response;
- DB result;
- staff-approved policy;
- ticket evidence.

## 2.2 Current memory

Materialized best-supported current conclusions.

Normal support retrieval reads this layer.

## 2.3 Memory history

Prior revisions.

Used only when:

- historical question;
- audit;
- debugging;
- source-change analysis.

---

# 3. Memory identity

A memory must have a stable logical key.

Recommended tuple:

    namespace
    key
    scope

Examples:

    network | connection.ip | global
    permission | command.fly | smp
    rank | legend.fly | smp
    feature | reputation.description | global
    procedure | inventory_loss.evidence | support

The key identifies the concept, not a particular value.

---

# 4. Revision states

## CURRENT

Best-supported current value.

At most one CURRENT revision per memory key/scope.

## SUPERSEDED

Was previously current but has a known replacement.

Never returned by normal current retrieval.

## INVALID

No longer supported and has no accepted replacement.

Never returned as current.

## CONFLICTED

Authoritative evidence disagrees and no precedence rule resolves it safely.

Normal response should investigate or communicate uncertainty.

## STALE

Source/version can no longer be proven current.

Do not return as verified current fact.

---

# 5. Atomic supersession

Transition A -> B must be one logical transaction:

1. lock memory key;
2. verify expected current revision if applicable;
3. create B;
4. change A CURRENT -> SUPERSEDED;
5. set B CURRENT;
6. link A.superseded_by = B;
7. link B.supersedes = A;
8. update current semantic index;
9. remove A from current semantic index;
10. invalidate dependent answer cache entries;
11. emit memory.changed event.

Never expose a state in which both A and B are CURRENT.

---

# 6. Evidence requirements

A durable current fact should have evidence.

Evidence record:

- source artifact ID;
- source version/hash;
- observed timestamp;
- verification timestamp;
- authority level;
- evidence role.

Possible roles:

- PRIMARY;
- SUPPORTING;
- CONTRADICTING;
- SUPERSEDING.

---

# 7. Verification algorithm

Before stating a mutable Enthusia fact:

1. classify claim type;
2. determine expected authority;
3. query current memory/source index;
4. check source version/freshness;
5. perform live lookup when required;
6. compare result to current memory;
7. if different, reconcile memory;
8. if conflict unresolved, do not state one side as certain;
9. construct answer from verified result.

---

# 8. Live-required claim types

Default live verification for:

- player roles;
- player ranks;
- player permissions;
- balances;
- ticket state;
- current server availability;
- current punishment/action state;
- current account link;
- other fast-changing player state.

Do not use a cached memory value when live state is cheap and authoritative.

---

# 9. Version-verifiable claim types

Indexed verification is sufficient when source version is current:

- code;
- configuration;
- documentation;
- plugin manifests;
- rules documents.

Example:

If config hash has not changed since indexing, derived facts from that config may be treated as current.

---

# 10. Deployment distinction

For code-derived facts, record:

- repository SHA;
- deployment artifact/version;
- target server.

Git main is not automatically production truth.

If main SHA differs from deployed SHA, the AI must use deployed behavior for questions about current production.

---

# 11. Answer-time reconciliation

Answer-time verification is also a memory maintenance mechanism.

Example:

Current memory:

    command.fly.rank = Legend

Live/authoritative check:

    Elite

Then before answering:

- create Elite revision;
- supersede Legend;
- answer Elite;
- retain Legend in history.

The AI should not answer Elite but leave Legend as current memory.

---

# 12. Background reconciliation

A generic Bloom task may periodically validate:

- source versions;
- file hashes;
- repository heads;
- deployment markers;
- cheap source-backed memories.

If a source changed:

- mark affected memory STALE;
- prioritize re-indexing;
- do not continue presenting old value as verified current.

Avoid creating one custom watcher per fact.

---

# 13. Current retrieval

Default memory search must include:

    state = CURRENT

It may optionally include CONFLICTED metadata for investigation.

It must not include:

- SUPERSEDED;
- INVALID;
- STALE

as normal answer candidates.

---

# 14. Historical retrieval

Historical mode is explicit.

Example triggers:

- "used to";
- "last year";
- "before the update";
- audit/debug query.

Historical answers must include temporal framing.

---

# 15. Semantic vector handling

When A is superseded:

- delete A from current collection, or
- update metadata so current-only filter excludes it.

Do not rely on the model to notice a text label saying "old."

A separate historical collection or mandatory state filter is preferred.

---

# 16. Conflicts

If current source evidence conflicts:

1. compare authority;
2. compare deployment relevance;
3. compare timestamps;
4. perform live lookup if possible;
5. if unresolved, state uncertainty;
6. create CONFLICTED memory state or incident;
7. do not choose based solely on retrieval score.

---

# 17. Authority examples

Command permission:

    live permission service
    deployed config
    deployed code
    current Git code not yet proven deployed
    staff note
    old ticket
    model weights

Server policy:

    current official policy
    owner/staff approved policy record
    current structured memory
    historical ticket practice
    model weights

---

# 18. Correction handling

Correction inputs can come from:

- owner;
- authorized staff;
- authoritative source change;
- tool result;
- deployment.

A human correction does not automatically erase provenance.

Flow:

1. record correction candidate;
2. locate source;
3. verify where practical;
4. supersede active memory;
5. record actor/reason;
6. create regression test candidate.

---

# 19. Bad-memory prevention

Do not promote:

- guesses;
- model-only hallucinations;
- unverified rumors;
- secrets;
- transient conversational statements;
- contradictory claims with no resolution.

---

# 20. Player-specific memory

Player memory must distinguish current live facts from historical support context.

Example:

Rank:
- live lookup.

Past ticket:
- historical/private support context.

A player's old rank must not remain current because it appeared in a prior ticket.

---

# 21. Memory event stream

Recommended events:

- memory.created;
- memory.verified;
- memory.superseded;
- memory.invalidated;
- memory.conflicted;
- memory.restored;
- source.changed;
- source.deleted.

These events enable audit, cache invalidation, and future UI.

---

# 22. Caching dependency graph

If answer caching is implemented, cached facts should record memory/source dependencies.

When dependency changes:

- invalidate cache entry.

Do not globally flush all caches for every change if targeted invalidation is available.

---

# 23. Test requirements

Mandatory automated tests:

- one CURRENT per key;
- A -> B supersession;
- old vector excluded;
- history retained;
- source deletion;
- stale source;
- conflict;
- concurrent updates;
- answer-time reconciliation;
- deployment SHA mismatch;
- live player state overrides memory;
- historical query sees superseded value.

---

# 24. Example end-to-end

Initial state:

    command.trade.minimum_rank = VIP
    source hash = abc

Player asks.

AI verifies hash abc current.
Answers VIP.

Later config changes:

    command.trade.minimum_rank = MEMBER
    source hash = def

Background index notices hash changed and invalidates facts derived from abc.

Next question:

- current memory from abc is STALE;
- AI reads source def;
- creates new MEMBER revision;
- marks VIP revision SUPERSEDED;
- updates current vector;
- answers MEMBER.

History still shows:

    VIP -> MEMBER

but normal current retrieval returns MEMBER only.

This behavior is mandatory.
