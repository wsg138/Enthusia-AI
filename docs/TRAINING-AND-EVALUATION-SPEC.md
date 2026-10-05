# Enthusia AI — Training and Evaluation Specification

**Authority:** Sub-specification of docs/MASTER-SPECIFICATION.md  
**Purpose:** Define how training data is created, curated, versioned, evaluated, fine-tuned, exported, and accepted.

---

# 1. Training objective

The model should be trained primarily to improve behavior rather than to memorize volatile Enthusia facts.

Desired learned behaviors:

- investigate before answering;
- use tools correctly;
- distinguish current from historical evidence;
- request the right evidence;
- recognize insufficient evidence;
- escalate appropriately;
- write useful support replies;
- reason over server context;
- avoid inventing commands/features;
- update current memory when verified facts change;
- keep historical memory separate;
- respect visibility and authorization;
- adapt support to the actual player/account/server context instead of giving generic FAQ answers;
- use linked identity, current roles/rank/permissions, relevant memory, and current server/plugin evidence when the question calls for them;
- avoid retrieving unrelated private context for simple questions;
- understand ticket conversations, ask only missing follow-up questions, summarize evidence, and choose the correct ticket-support next step;
- personalize onboarding based on what is already known/verified about the player rather than repeating completed steps;
- distinguish a durable behavioral lesson from a volatile fact that belongs in live retrieval.

Current server facts should remain source-backed and retrievable.

---

# 2. Planned data sources

The project plan includes:

- historical real Enthusia support tickets;
- owner/staff-authored ideal conversations;
- synthetic support conversations;
- synthetic tool-use traces;
- server documentation;
- rules;
- plugin/config-derived feature descriptions;
- known-bug scenarios;
- corrected AI responses;
- escalation cases;
- code-investigation examples;
- privacy/security negative examples;
- adaptive support scenarios with identity/rank/permission/server context;
- ticket automation scenarios including triage, targeted follow-up, investigation, summarization, and lifecycle action requests;
- dynamic onboarding scenarios where prior/current player context changes the correct response.

Synthetic/support training data should deliberately include paired cases where the same apparent user question has a different correct investigation or answer because the player's current context differs. This is necessary to teach adaptive support rather than static FAQ behavior.

The historical ticket corpus is an owner-directed planned data source. Before the extraction/training job is executed, create a documented governance/compliance checkpoint covering source, authorization, applicable platform/data obligations, retention, exclusions, and handling.

---

# 3. Training versus retrieval

Do not train volatile facts merely because they are available.

Examples that should usually remain retrieval/live-tool knowledge:

- current IP;
- current permission mapping;
- current rank benefits;
- current prices;
- current plugin configuration;
- current known-bug state.

Examples suitable for behavioral training:

- how to verify current IP;
- how to investigate permission failure;
- what evidence to request for inventory loss;
- when to escalate;
- how to write a concise player response.

---

# 4. Historical ticket processing

The ticket pipeline should not simply dump raw transcripts into training.

Stages:

1. extract;
2. normalize;
3. remove secrets;
4. mark speaker roles;
5. identify problem;
6. identify evidence;
7. identify staff actions;
8. identify outcome;
9. label quality;
10. mark potentially stale factual content;
11. create normalized training candidates;
12. review/filter.

Possible candidate labels:

- IDEAL;
- GOOD;
- USABLE_WITH_EDIT;
- BAD_RESPONSE;
- OUTDATED;
- INCOMPLETE;
- PRIVATE_EXCLUDE.

Bad/outdated examples may still be useful as negative/evaluation cases.

---

# 5. Synthetic corpus

Generate broad coverage from authoritative current sources.

For each feature/system create variations:

- simple FAQ;
- typo-heavy question;
- new-player wording;
- advanced question;
- incorrect assumption;
- missing evidence;
- conflicting evidence;
- player-specific troubleshooting;
- historical question;
- staff-only question;
- escalation-required case.

Generate more than one linguistic form per underlying scenario.

---

# 6. Tool-use examples

Train tool selection explicitly.

Example skeleton:

    User asks why /fly fails.
    Agent resolves linked Minecraft account.
    Agent reads live rank/permission.
    Agent searches command/plugin config.
    Agent compares expected versus actual.
    Agent answers or escalates.

The model should learn investigation patterns, not secret credentials or private hidden reasoning.

---

# 7. Dataset partitions

Minimum:

- TRAIN;
- VALIDATION;
- TEST.

Additionally maintain:

- OWNER_GOLDEN;
- ADVERSARIAL;
- STALE_TRUTH;
- PRIVACY_SECURITY;
- TOOL_FAILURE.

Do not tune against OWNER_GOLDEN or final TEST after freezing.

---

# 8. Leakage prevention

Near-duplicate scenarios must not cross train/test splits.

Deduplicate by:

- normalized text;
- semantic similarity;
- shared ticket/thread;
- same synthetic template;
- same underlying fact/scenario.

---

# 9. Dataset versioning

Every immutable release gets an ID such as:

    enthusia-ai-dataset-2026.10.03-v1

Manifest includes:

- source sets;
- counts;
- filters;
- generator model/version;
- preprocessing commit;
- exclusions;
- hashes.

---

# 10. Quality review

Automated filters:

- secrets;
- malformed records;
- duplicates;
- unsupported facts;
- excessively long examples;
- empty answers;
- broken tool traces.

Human/owner review should focus on high-impact categories and random samples.

---

# 11. Baseline first

Before fine-tuning, evaluate the untouched candidate base model using the same agent tools.

This answers:

- how much does RAG/tools already solve?
- what behaviors actually need training?
- does fine-tuning improve or damage general reasoning?

Never judge fine-tune improvement without baseline.

---

# 12. Candidate model evaluation

Evaluate likely 14B–30B-class models.

Measure:

- QA accuracy;
- tool use;
- JSON/schema adherence;
- hallucination;
- source verification;
- escalation;
- latency;
- RAM;
- CPU;
- context.

Do not permanently lock model before benchmark.

---

# 13. Owner hardware

Available local training machine:

- RTX 4060 Ti;
- 8 GB VRAM;
- 64 GB system RAM.

Use it for:

- preprocessing;
- embeddings;
- dataset generation/validation;
- small-model training;
- pipeline testing;
- evaluation;
- quantization experiments where feasible.

Large target models may technically support offload but can become impractically slow.

---

# 14. External GPU budget

Initial hard cap:

**USD $25 total**

Do not exceed without owner approval.

GPU rental should happen only after local pipeline validation.

---

# 15. Rental selection

Select hardware by measured total value, not prestige.

Consider:

- VRAM requirement;
- tokens/sec;
- cost/hour;
- expected run length;
- storage cost;
- setup overhead.

If a 48 GB GPU fits the chosen QLoRA configuration, it may provide more iteration time than an A100 80 GB.

If the model/configuration requires A100-class VRAM/bandwidth, use it selectively.

---

# 16. Rental preparation checklist

Before paid instance starts:

- dataset uploaded/prepared;
- dependencies pinned;
- training command tested locally/small model;
- checkpoint interval chosen;
- logging configured;
- evaluation command ready;
- export command ready;
- artifact destination ready.

Paid GPU should not be used to debug basic path/config errors.

---

# 17. Fine-tune method

Initial preferred approach:

- supervised fine-tuning;
- LoRA or QLoRA;
- parameter-efficient adapters;
- conservative learning rate;
- short experimental runs before full run.

Full-model training is outside initial budget/scope.

---

# 18. Hyperparameter tracking

Record:

- base model;
- tokenizer;
- quantization;
- LoRA rank;
- alpha;
- dropout;
- target modules;
- learning rate;
- optimizer;
- batch size;
- gradient accumulation;
- sequence length;
- epochs/steps;
- scheduler;
- seed.

---

# 19. Checkpoint strategy

Checkpoints should allow:

- recovery;
- comparison;
- early stopping.

Do not save so frequently that storage dominates cost.

---

# 20. Evaluation after each run

Compare to baseline on:

- owner golden;
- stale-truth suite;
- tool-selection suite;
- privacy suite;
- escalation suite;
- general support.

Fine-tune should be rejected if it improves style but materially worsens:

- factual grounding;
- tool use;
- privacy;
- escalation;
- reasoning.

---

# 21. Stale-truth evaluation

Mandatory scenario:

Training/historical examples contain old fact A.

Current source says B.

Model must:

- verify;
- answer B;
- not repeat A as current.

This is essential because historical ticket data will contain old server behavior.

---

# 22. Tool adherence evaluation

Measure:

- required tool called;
- unnecessary tools avoided;
- live verification used when needed;
- correct source precedence;
- bounded loops.

---

# 23. Escalation evaluation

Cases should include:

- local model sufficient;
- OpenAI needed;
- human staff needed;
- no escalation needed despite ambiguity resolved by tool.

Avoid both over-escalation and under-escalation.

---

# 24. Output artifact

Each production candidate should include a manifest:

    model base
    adapter
    quantization
    dataset version
    training commit
    evaluation report
    artifact hash
    created date

---

# 25. Quantization

Benchmark multiple practical quantizations if needed.

Evaluate:

- answer quality;
- RAM;
- speed;
- SMP impact.

Do not choose smallest artifact if quality falls below acceptance.

---

# 26. Production A/B or shadow testing

Before replacing production model:

- run shadow on real requests where permitted;
- compare current production response against candidate;
- do not expose candidate answer automatically;
- collect quality differences.

---

# 27. Continuous dataset improvement

Create dataset candidates from:

- staff corrections;
- AI failures;
- missed tool calls;
- bad escalations;
- new support patterns;
- new features.

Do not immediately train every candidate.

Review/version them.

---

# 28. Retraining trigger

Retrain when there is meaningful behavioral data accumulation or a model upgrade.

Do not retrain solely because:

- config changed;
- one command changed;
- one feature changed.

Those belong in live knowledge.

---

# 29. Cost accounting

Track:

- GPU rental cost;
- storage;
- external generation/evaluation API cost if any;
- model training duration.

The $25 GPU cap must be visible to workers.

---

# 30. Definition of training success

The fine-tuned model is successful if, compared with the base:

- better support procedure;
- better tool use;
- lower unsupported-answer rate;
- better escalation;
- maintains or improves privacy;
- does not trust stale ticket facts over current evidence;
- remains computationally practical on Bloom.

The purpose is not to maximize benchmark vanity metrics.

The purpose is to improve the complete Enthusia AI system.
