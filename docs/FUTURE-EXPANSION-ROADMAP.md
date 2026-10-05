# Enthusia AI — Future Expansion Roadmap

**Status:** Architectural roadmap.  
**Authority:** Complements `docs/MASTER-SPECIFICATION.md`.  
**Important:** Adaptive support, ticket automation, player-aware onboarding, current-memory semantics, evidence verification, Discord support, staff assistance, and Minecraft `/ai` are core product capabilities and are **not** deferred to this roadmap.

---

# 1. Expansion principle

Enthusia AI should become the shared intelligence and decision-support layer for the Enthusia network.

Expansion should not create a collection of unrelated AI features inside individual plugins. New systems should reuse:

- the same agent/orchestrator;
- the same player identity/context service;
- the same current-memory/history model;
- the same knowledge/RAG system;
- the same provenance model;
- the same authorization/visibility controls;
- the same tool gateway;
- the same audit/trace model;
- the same OpenAI escalation path.

The preferred pattern is to make plugins expose **typed capabilities** to Enthusia AI.

The model should not receive arbitrary Java objects, unrestricted SQL, raw shell access, or unrestricted administrative mutation authority.

---

# 2. Capability contract pattern

A plugin/service integration should expose narrowly defined operations such as:

- `get_current_state(...)`
- `get_player_context(...)`
- `list_available_options(...)`
- `get_history(...)`
- `propose_action(...)`
- `request_action(...)`

Read and decision-support capabilities should be easier to authorize than mutations.

Structured decision output should include:

- decision/recommendation ID;
- confidence;
- evidence/source references;
- current-state assumptions;
- reason codes;
- requested action;
- authorization level;
- expiry/freshness;
- trace ID.

Execution remains deterministic.

Before carrying out a model recommendation, policy code should validate:

- authorization;
- visibility;
- current state;
- cooldowns;
- limits;
- plugin invariants;
- reversibility;
- rate limits;
- whether approval is required;
- whether the evidence has gone stale.

High-impact/destructive actions remain staff/owner controlled.

---

# 3. Future track — Economy Intelligence

## 3.1 Goal

Build an intelligence layer over the Enthusia economy that can explain economic conditions, detect anomalies, investigate unusual activity, and recommend interventions without giving an unconstrained model direct write access to balances or prices.

## 3.2 Potential capabilities

- market-health summaries;
- inflation/deflation trends;
- item price history;
- unusual balance changes;
- unusual income/outflow patterns;
- shop liquidity;
- concentration of wealth;
- suspicious transfers;
- exploit/anomaly investigation;
- price outlier detection;
- economy event impact analysis;
- tax/fee impact simulation;
- staff-facing recommendations;
- player-facing market explanations;
- "why did this item's price move?" analysis;
- proactive staff alerts for meaningful anomalies.

## 3.3 Possible typed tools

- `economy.get_market_health()`
- `economy.get_price_history(item, window)`
- `economy.get_player_flow(player, window)`
- `economy.get_supply_demand(item, window)`
- `economy.get_outliers(window)`
- `economy.simulate_policy_change(change)`
- `economy.propose_intervention(context)`

Actual balance/price mutations should remain separate actions with deterministic policy checks and explicit authorization.

## 3.4 Training/evaluation implications

Future evaluation should test:

- distinguishing anomaly from legitimate high-volume activity;
- not accusing players without evidence;
- explaining uncertainty;
- avoiding stale price memory;
- using current market data;
- respecting player/staff visibility;
- escalating suspected exploit behavior appropriately.

---

# 4. Future track — AI Server Operations / Enthusia Doctor overhaul

## 4.1 Goal

Use the existing `wsg138/EnthusiaDoctor` project as conceptual/implementation input for a larger server-operations intelligence system integrated into Enthusia AI.

This should be an overhaul, not merely bolting an LLM onto the current Doctor implementation.

The future system should combine deterministic telemetry/health collection with AI investigation and explanation.

## 4.2 Potential capabilities

- server health summaries;
- TPS/MSPT/resource analysis;
- JVM/GC interpretation;
- memory-pressure detection;
- CPU/disk/network anomaly analysis;
- startup/shutdown diagnostics;
- plugin exception clustering;
- recurring error detection;
- failed-dependency diagnosis;
- deployment regression correlation;
- "what changed before this broke?" investigation;
- cross-server incident correlation;
- known-issue matching;
- automatic evidence bundles for GitHub issues;
- safe remediation recommendations;
- rollback recommendation;
- post-incident summaries;
- trend reports;
- proactive warnings when a condition is likely to become player-visible.

## 4.3 Architecture

Deterministic collectors should own raw telemetry.

Example sources:

- Pterodactyl/Bloom metrics;
- Paper/Leaf timings/health;
- JVM/GC metrics;
- logs;
- deployment metadata;
- plugin/runtime versions;
- current config hashes;
- process/container resource limits;
- service readiness;
- network/proxy health;
- database health indicators.

Enthusia AI should reason over structured observations rather than scraping arbitrary shell output whenever possible.

## 4.4 Possible typed tools

- `ops.get_server_health(server)`
- `ops.get_resource_history(server, metric, window)`
- `ops.get_recent_errors(server)`
- `ops.get_deployment_diff(server, before, after)`
- `ops.get_runtime_versions(server)`
- `ops.correlate_incident(window)`
- `ops.propose_remediation(incident)`
- `ops.create_incident_report(incident)`

Initial versions should be read-only/recommendation-only.

Low-risk reversible actions could later be exposed individually, but production restart/rollback/config mutation should require explicit authorization until extensive evidence proves safe automation.

---

# 5. Future track — Plugin decision support

Plugins may eventually request bounded AI decisions.

Example:

```json
{
  "decision_type": "choose_next_event",
  "context": {
    "online_players": 46,
    "recent_event_types": ["pvp", "pvp", "combat"],
    "server_health": "normal",
    "available_events": ["block_party", "spleef", "sumo"]
  }
}
```

The AI may return:

```json
{
  "decision": "block_party",
  "confidence": 0.91,
  "reason_codes": [
    "recent_event_variety",
    "player_count_fit",
    "server_health_ok"
  ]
}
```

The Events plugin still validates map availability, player-count bounds, cooldowns, and all hard game rules before execution.

Potential future domains:

- event selection;
- NPC/quest recommendations;
- player activity recommendations;
- guild discovery;
- tutorial/onboarding path selection;
- support-routing decisions;
- non-destructive maintenance prioritization.

---

# 6. Future track — Proactive intelligence

Enthusia AI may eventually consume event streams and investigate meaningful changes without waiting for a user question.

Examples:

- multiple players report the same command failure after a deployment;
- an economy metric crosses an anomaly threshold;
- an error signature suddenly increases;
- a server repeatedly approaches a resource limit;
- a known-bug signature appears after a plugin update.

Proactive behavior must remain bounded.

The system should:

1. detect through deterministic thresholds/events where possible;
2. open an investigation trace;
3. gather minimum relevant evidence;
4. assess severity/confidence;
5. notify staff only when meaningful;
6. avoid repetitive alert spam;
7. never autonomously perform destructive remediation solely because a generative model suggested it.

---

# 7. Future-proofing requirements for current work

Current implementations should avoid choices that make future expansion unnecessarily difficult.

Prefer:

- stable typed tool contracts;
- capability discovery/registration;
- source/provenance envelopes shared across tools;
- actor/authorization context passed explicitly;
- common trace IDs;
- event-driven memory invalidation;
- structured decision outputs;
- policy validation outside the model;
- service boundaries rather than plugin-to-plugin hard coupling;
- versioned schemas;
- idempotent action-request APIs;
- observable latency/failure metrics;
- reversible actions where possible.

Avoid:

- hard-coding the agent to only Discord questions;
- assuming every request is a support FAQ;
- embedding mutable server facts in prompts/model weights;
- giving each plugin a separate AI model/memory store;
- exposing unrestricted SQL/shell/console as generic model tools;
- letting model text directly trigger destructive actions;
- creating plugin integrations that bypass central visibility/authorization.

---

# 8. Expansion maturity levels

## Level 0 — Knowledge

AI can retrieve/explain system state.

## Level 1 — Investigation

AI can combine multiple sources/tools to diagnose a problem.

## Level 2 — Recommendation

AI can return structured recommendations/decisions; deterministic systems decide whether/how to apply them.

## Level 3 — Approved action requests

AI can request typed actions from authoritative services. The authoritative service re-validates state/authorization.

## Level 4 — Low-risk bounded autonomy

Selected reversible, low-impact actions may execute automatically under explicit policy.

## Level 5 — High-impact automation

Only consider after substantial production evidence, auditing, rollback, evaluation, and owner approval. High-impact/destructive operations should not become autonomous merely because the model becomes more capable.

---

# 9. Near-term priorities remain unchanged

Future expansion must not distract from the immediate product:

1. adaptive support;
2. ticket automation/integration;
3. player-aware context and onboarding;
4. current-vs-historical memory correctness;
5. live fact verification;
6. high-quality local-model training/evaluation;
7. stable Discord/Minecraft surfaces;
8. safe OpenAI escalation;
9. production deployment/observability.

The future systems in this document should build on those foundations rather than compete with them.
