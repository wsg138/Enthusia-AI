# Synthetic Ticket Worker Generation Plan

Status: generation framework for the post-owner-review ticket corpus expansion.

## Goal

Generate approximately 1,500 **candidate** support conversations using 15
independent workers at roughly 100 candidates each.

These are not automatically training data. They are an intentionally broad
candidate pool that must pass grounding, privacy, deduplication, review, and
W16/W19 admission gates.

The behavioral authority for all workers is:

- `training/ticket-corpus/OWNER-REVIEW-RUBRIC.md`;
- `docs/TRAINING-AND-EVALUATION-SPEC.md`;
- current authoritative Enthusia source/config/runtime evidence.

Historical staff replies are reference-only.

## Owner decisions that control this run

The assistant should investigate rather than act as a passive ticket form.

The assistant should:

1. ask only for missing information it cannot retrieve itself;
2. investigate authoritative logs, databases, proxy/runtime state, current
   plugin/source state, player context, and recent ticket memory when relevant;
3. keep player-facing messages natural and concise;
4. keep deeper/internal evidence in a separate staff-only surface when needed;
5. recommend discretionary restoration/rollback/reimbursement actions to staff,
   not perform them in the current system;
6. use code inspection or JAR decompilation when runtime evidence points toward
   an implementation bug and source is insufficient;
7. reserve aggressive staff escalation for genuinely major/game-breaking
   exploits or comparable high-impact incidents.

## GPU rule

Synthetic generation, review, deduplication, and dataset preparation are CPU/API
work. They must not consume the remaining training GPU balance.

Current owner direction:

- do not start another paid GPU run while building this corpus;
- remaining balance is approximately USD 4.57;
- any additional owner funding is capped at USD 10 and requires a concrete
  justification before it is spent.

## Candidate format

Workers generate a **candidate conversation package**, not a final W16 record.

Each candidate must separate:

- player-visible conversation;
- assistant-visible conversation;
- investigation/tool intents;
- synthetic fixture evidence or source-backed findings;
- staff-only evidence summary/recommendation;
- grounding/provenance;
- quality flags.

Suggested shape:

```json
{
  "candidate_id": "W03-0042",
  "lane": "guild-economy",
  "seed_refs": ["ticket-rewrite-273"],
  "source_refs": [
    {"kind": "repo", "ref": "wsg138/LumaGuilds@<sha>:<path>"}
  ],
  "scenario_facts": {
    "fixture_only": true,
    "facts": []
  },
  "conversation": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "investigation": [
    {
      "intent": "read guild vault transaction history",
      "result_summary": "...",
      "visibility": "staff_only",
      "evidence_kind": "synthetic_fixture"
    }
  ],
  "staff_handoff": {
    "needed": true,
    "evidence_summary": "...",
    "recommendation": "...",
    "visibility": "staff_only"
  },
  "quality": {
    "self_review": "PASS",
    "risks": []
  }
}
```

This format is intentionally richer than the final fine-tuning schema. A later
review/normalization pass decides which portions become visible messages,
expected tool actions, or staff-only/evaluation data.

## Synthetic evidence rule

Workers must not invent a database row, log line, ticket memory, deployed state,
or other mutable fact and present it as current Enthusia truth.

A generated conversation may contain fictional **scenario-local fixture
evidence** only when all of the following are true:

- the value is explicitly marked as synthetic fixture data;
- the field/event type is supported by real source/schema/runtime behavior;
- no real player identity, credential, or private value is copied;
- the fixture does not claim to describe production;
- downstream conversion preserves the synthetic provenance.

Real current claims must be source-backed.

## 15 generation lanes

Each lane targets about 100 candidates. Workers should vary player phrasing,
conversation length, missing information, evidence quality, outcomes, and
whether staff escalation is necessary.

### W01 — stalls, market ownership, regions, permissions

Seed families: stall ownership divergence, guild/personal stall selection,
closed/blocked stall access, ghost ownership, market permission mismatch.

Focus on DB/ownership/region/plugin-log investigation and interactive debugging.

### W02 — market transactions, rewards, economy reconciliation

Seed families: shop purchases, stock mismatch, duplicate/late transactions,
reward claim state, event rewards/tags where transaction or eligibility records
matter.

Focus on transaction reconciliation. No automatic reimbursement.

### W03 — guild state, vaults, guild permissions, shared ownership

Seed families: guild vault withdraw mismatch, guild-owned stalls, membership and
role-dependent access, shared/guild resource state.

Focus on authoritative guild membership/role/state plus transaction evidence.

### W04 — lag, disconnects, restarts, deaths, rollback evidence

Seed families: void lag, combat disconnect, ghosting, restart deaths, client
disconnect during dangerous state.

Always consider backend **and proxy** evidence. Produce staff-ready rollback
evidence without performing restoration.

### W05 — inventory/item loss and recurring item-state bugs

Seed families: disappearing elytra/chestplate/spear, vanished mobs/items,
inventory swaps, enchant/state loss.

Use item/inventory evidence where available, client/mod context, recent-memory
search, and recurring-bug correlation.

### W06 — duels, PvP, bounties, heads, combat evidence

Seed families: spectator interference, missing bounty/head rewards, combat-log
edge cases, duel-state discrepancies.

Separate exploit/bug investigation from reimbursement/rollback decisions.

### W07 — dupes, exploit reports, restriction bypasses

Seed families: stall dupe, storage bypass, restricted-item edge cases, AFK
credit abuse and other serious exploit reports.

Ask privately for reproducible steps/evidence. Do not teach the exploit in
player-visible output. Aggressive escalation only for genuinely high-impact
active issues.

### W08 — Bedrock/Java differences, linked accounts, homes/beds

Seed families: Bedrock command differences, Java/Bedrock account links,
home/bed/respawn state, Geyser-specific behavior.

Search recent ticket memory and verify platform-specific implementation rather
than assuming Java behavior applies.

### W09 — proxy, connectivity, Gatekeeper, Geyser, network path

Seed families: stale connection state, proxy/backend failures, false VPN
classification, Bedrock join incompatibility, disconnect errors.

Correlate player symptoms with proxy/backend/plugin logs and deployed versions.

### W10 — client mods, rendering, movement, visual/display bugs

Seed families: black screen/render issues, movement collision problems,
nametag/display issues, client/mod interactions.

Ask for mod list when useful and debug interactively. Distinguish client,
protocol, and server/plugin causes.

### W11 — Discord/bot/bridge/integration behavior

Seed families: Discord player-list mismatch, bot bridge state, cross-platform
command behavior, integration desynchronization.

Compare both sides of the integration, then inspect source/JAR behavior if
runtime evidence is insufficient.

### W12 — account compromise, recovery, identity continuity

Seed families: hacked Microsoft/Minecraft accounts, old/new account transfer,
linked identity and ownership proof.

Exact recovery questioning must come from current memory/workflow rather than
being memorized as permanent model knowledge.

### W13 — runtime/plugin failures, restarts, deployed-artifact diagnosis

Seed families: crashes, restart-related behavior, plugin regressions, deployed
version mismatch, source-versus-runtime discrepancies.

Use live/deployed provenance rules. Source main is not automatically production.

### W14 — reputation/support disputes and human-decision handoff

Seed families: false/down reputation reports and other support disputes where
evidence can be investigated but the outcome remains a human/staff decision.

Teach evidence collection, neutral summaries, confidence, and safe handoff. Do
not train automatic punishment or unrestricted moderation authority.

### W15 — complex cross-system investigations

Use cases requiring several systems: ticket memory + logs + DB + source,
proxy + backend + player state, or runtime evidence + code/JAR inspection.

This lane intentionally tests orchestration and stopping conditions. It should
contain both cases that become solvable and cases where evidence remains
insufficient.

## Diversity requirements per worker

Each worker's 100 candidates should include a deliberate mix of:

- short and long conversations;
- typo-heavy/Discord-like player language;
- calm and frustrated users;
- Java and Bedrock where relevant;
- complete evidence and missing evidence;
- false assumptions by the player;
- conflicting evidence;
- recurring known issue versus novel issue;
- tool succeeds, tool unavailable, and tool returns inconclusive evidence;
- no staff handoff needed;
- staff handoff required;
- player-safe explanation plus staff-only evidence;
- at least several cases where the correct answer is to **avoid** unnecessary
  escalation;
- at least several cases where the model must search recent ticket memory.

Do not make every conversation follow the same question sequence.

## Acceptance before training

A candidate does not enter W16 merely because its generating worker says PASS.

Required later gates:

1. schema/secret/privacy validation;
2. source/provenance validation;
3. unsupported-current-fact rejection;
4. cross-worker near-duplicate detection;
5. style and dialogue realism review;
6. investigation/tool correctness review;
7. staff/private visibility review;
8. escalation-level review;
9. independent model/judge review;
10. stratified coordinator sampling;
11. owner review only when a high-impact policy question remains or a later
    sample is intentionally requested.

The owner has completed the initial 20-example policy review and does not need to
review another large block before generation starts.
