# Enthusia AI ticket corpus — methods review after closed 15-worker generation

Date: 2026-10-07 (US Central). Status: **audit/design and synthetic-only tests; not a training-admission certificate**.

Inspired by the separate AI-Moderation-API Data/Model v2 methods review and
`tools/data_v2/test_method_invariants.py` at branch
`docs/data-model-v2-training-readiness`. The two projects serve different tasks.
Do **not** apply their 120-second chat window, single-latest-target classifier
rules, or moderation policy thresholds to long-running support tickets.

## Decision

**Prioritize trustworthy training targets and source/incident lineage over
manufacturing more candidate conversations or paying for another GPU.** The
workers have finished or timed out; the owner has explicitly closed the
generation phase and does not want more rounds of owner-review examples.

Actual private data remains only on the authorized Windows PC.
This public document contains aggregate counts and code-only examples.

## Verified source state / local audit

- Output directory:
  `C:\Users\racec\Blackboard\Enthusia-AI-Training\SyntheticWorkers\outputs`
- 1,301 parseable candidate JSONL records across 14 existing lane files.
- W01 and W03–W14 have 100 records each; W02 has one; W15 has zero.
- 1,301/1,301 passed *basic structural* checks; no exact normalized
  conversation duplicates in the initial lexical audit.
- **540** structurally full multi-turn examples (at least two user and two
  assistant turns); **761** are shorter or otherwise insufficient for the
  full ticket-conversation objective.
- 2,632 internally labeled investigation steps:
  - 2,130 explicitly synthetic fixture evidence steps;
  - 373 worker-claimed source-backed steps;
  - 129 unavailable/inconclusive steps.
- **0/2,632** investigation steps have a verified turn anchor. Therefore they
  cannot yet be interpreted as chronological tool-use traces.
- Grouping by connected seed/incident lineage produced **30 components**;
  largest component sizes were 294, 148, 146, 120, 54.
- **0 examples are currently independently approved or W16/W19 eligible.**

Private aggregate and per-candidate audit artifacts:

- `audit/audit-summary.json`
- `audit/quality-indicators.json`
- `audit/triage-index.jsonl`
- `audit/triage-summary.json`
- `audit/method-v2-audit.json`
- `audit/method-v2-lineage-groups.json`

## Methodology adapted from the moderation review

### 1. Immutable separation and admission

Keep candidate source JSONL immutable. Maintain separate private manifests for:

1. historical sanitized real-ticket seeds;
2. synthetic generated *unreviewed* conversations;
3. independently reviewed corrections and training targets;
4. evaluation/adversarial/known-failure suites;
5. the frozen, versioned training release.

No `glob("*.jsonl")` over the entire output directory for W16/W19. Local
partial W12 batch fragments and unreviewed workers' PASS labels **must not**
be automatically ingested.

Each admitted example needs:

- source revision + content digest;
- source use/rights and deletion/retention status;
- worker/rewrite generator identity and review protocol revision;
- normalized scenario and conversation;
- seed incident identifiers, family/session/augmentation lineage;
- real/synthetic fixture labeling, any semantic conflicts;
- visibility and safety checks;
- explicit independent reviewer disposition;
- allowed use (train/development/holdout/reference/none);
- frozen split assignment + release manifest hash.

An upstream source deletion/withdrawal must invalidate or quarantine affected
descendants. Do not publish raw private ticket content, low-entropy hashes
of names, or individual player linkage identifiers to GitHub.

### 2. Causal investigation order, not a 120-second window

Support tickets can span minutes, hours, or days. Use the ticket thread/incident
identity as the trust boundary, not proximity in time.

For future approved multi-turn *tool-training* records, each internal tool
step must carry a **turn anchor** (e.g. `after_turn_index`) and an
`observed_at` timestamp when available. It must not use messages or tool
results learned after that turn. If evidence is discovered later, present it as
a later tool response, never retrospectively as earlier model knowledge.

Existing 2,632 unanchored worker investigation traces are **reference-only
tool intents** until independently reconstructed and checked. Do not silently
convert them to model-visible tool results or reward the model for claims that
it checked unavailable records.

Keep player-visible and staff-only channels separate. Staff recommendations
are not automatically inserted as ordinary player-facing assistant messages.

### 3. Leakage-resistant partitioning

Assign train/validation/test at connected-component level, unifying:

- same source ticket or source message;
- shared seed incident;
- the same conversation/session;
- same augmented parent/variant family;
- canonical mirrored incident event.

Generic statements, shared public documentation, or common words alone
are not sufficient to claim source leakage.

The current 30 family components are too coarse to safely assume independent
random row splits. Perform an independent grouping sanity review before
freezing any partitions. W20 owner-golden and final test remain immutable
and must not be trained on. For reliable claims about new tickets, prefer a
separately collected prospective holdout once authorized.

### 4. Quality: full conversations versus single turns

Only 540 records meet the minimum four-message back-and-forth shape. That is
necessary but **not sufficient** for training admission.

Place 761 shorter candidates in a secondary review track for potential
single-turn question/answer or triage-instruction training, not as fake
full-ticket logs. Do not inflate training statistics by counting them as
complete multi-turn interactions.

Next review should include a stratified independent sample from all lanes
and checks for script-like first AI openings, repetitive dialogue, source
misrepresentation, unreal tool claims, incorrect escalation, and staff-only
information leakage.

### 5. Grounding and abstention

A filled `source_refs` array does **not** demonstrate that an exact code,
configuration, database, or runtime claim is true. Validate cited source
revisions, implemented behavior, and whether the source was truly deployed.
`source_backed` is just a worker assertion until checked.

If a backend/proxy/log/database tool is unavailable, the model must tell the
player what is not verified and avoid inventing a finding. Return an
evidence-backed staff recommendation only within current authority.

### 6. Test approach

`tools/ticket_method_invariants.py` and
`tests/test_ticket_method_invariants.py` implement synthetic-only,
deterministic invariants:

- required candidate structure, typed booleans and explicit fixture status;
- visibility boundary and strict read-only mutation flag;
- optional timestamp monotonicity;
- no future-context tool anchor when present;
- true multi-turn shape as an optional acceptance gate;
- linked-source/seed/parent connected-component grouping;
- family leakage detection across splits;
- generic common policy/source references are not treated as leakage.

These tests do **not** access private data or infer positive quality labels.
They are not a replacement for independent factual, privacy, security, and
naturalness review.

## Explicit next gates

1. Run synthetic-only unit tests and audit local candidates without modifying
   originals. **Completed** (15 tests passed locally).
2. Create private immutable manifest with per-file hashes/line references and
   no raw content copied into GitHub.
3. Independently sample and review full multi-turn records, with rejection
   reasons and provenance.
4. Review large lineage-component collisions, then reserve family-group
   partitions *before* model experiments.
5. Add a verified as-of-turn tool-trace representation for selected reviewed
   candidates. Non-reconstructable traces remain reference-only.
6. Only independently GOOD/IDEAL and policy-cleared records may be explicitly
   transformed into W16/W19; block generic worker PASS labels from promotion.
7. Run CPU-only export/preflight. Train/evaluate only after dataset freeze,
   baseline definition, and **separate owner GPU spending approval**.

This plan does not authorize new historical extraction, paid GPU work, model
training, public publication of ticket content, or production deployment.
