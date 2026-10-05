# Live Plugin Intelligence Audit — index

Issue: #34  
PR: #35

## Scope completed in this PR

Fresh/current SMP:

- deployed plugin inventory with hashes and metadata;
- declared dependency graph;
- command/permission catalog;
- current first-party/player-facing feature state;
- deployment/source provenance;
- runtime integration graph;
- scrubbed runtime health findings;
- source-registry drift analysis;
- TestServer staging comparison;
- network/source coverage and freshness report;
- model exposure/redaction boundary;
- prioritized third-party exact-version research;
- missing typed-tool recommendations.

## Key truth corrections

- GitHub main is not treated as production.
- TestServer is not assumed newer than SMP.
- Guild claims are currently disabled even though claim code exists.
- Plan is not installed on current SMP despite enabled integration flags in some configs.
- RoseChat message enforcement is active while automatic punishments are disabled.
- Current RoseChat deployment is incompatible with expected Tags/Staff presence APIs.
- TicketBot internal lifecycle API is merged but not deployed.
- LumaGuilds economy initially starts before its provider, then later successfully hooks EnthusiaCurrency/TokenEconomy.
- Express, LumaGuilds and Market source-registry mappings were proven stale against production provenance.

## Files

- `SMP-BASELINE.md` — fresh deployment/runtime baseline.
- `SMP-PLUGIN-INVENTORY.md` — deployed JAR inventory summary.
- `data/SMP-PLUGIN-METADATA.json` — machine-readable plugin metadata.
- `data/SMP-DECLARED-DEPENDENCY-GRAPH.json` — machine-readable declared dependency graph.
- `SMP-COMMAND-CATALOG.md` — command/permission catalog.
- `SMP-CURRENT-FEATURE-STATE.md` — current player/staff feature state.
- `SMP-INTEGRATION-GRAPH.md` — runtime/dependency integration graph.
- `SMP-DEPLOYMENT-PROVENANCE.md` — source/release/build provenance.
- `SMP-RUNTIME-HEALTH.md` — scrubbed current runtime degradations.
- `SOURCE-REGISTRY-DRIFT.md` — stale/current source-authority audit.
- `TEST-STAGING-COMPARISON.md` — fresh test-only comparison.
- `COVERAGE-STALE-UNKNOWN.md` — target/source freshness and unknowns.
- `MODEL-EXPOSURE-BOUNDARY.md` — gateway vs model exposure policy.
- `THIRD-PARTY-EXACT-VERSION-MAP.md` — prioritized official exact-version research.
- `MISSING-TYPED-TOOLS.md` — recommended current-state read surfaces.

## Follow-up issues

- #36 — restore correct RoseChat presence-capable production artifact.
- #37 — advancement Discord icon rendering compatibility.
- #39 — resolve remaining plugin source provenance.
- #40 — restore fresh non-SMP target coverage.
- #41 — implement typed current plugin intelligence read tools.

Separate external/plugin defects found by this audit:

- `wsg138/PieCloak#17` — repeated post-spawn reconciliation expiration.
- `wsg138/EnthusiaLoreItems#39` — physical-tracking scan queue saturation.
- EnthusiaStaff issue #236 — fake-entity cheat-test adapter fail-closed evidence.
- EnthusiaStaff issue #332 — preserved exact production source provenance.

## Not completed by design

The following are not silently represented as current:

- Hub / Velocity / Test2 / Build / Sentinel current inventories while their read path is stale;
- exact source repos for EnthusiaDisplay / EnthusiaMapShields / PoseProbe;
- unresolved exact build provenance for several third-party snapshot/Jenkins-distributed plugins.

Those gaps are explicit and tracked rather than guessed.
