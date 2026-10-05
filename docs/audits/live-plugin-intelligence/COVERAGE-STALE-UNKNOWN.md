# Coverage, freshness, stale and unknown report

Audit baseline: fresh SMP snapshot captured 2026-10-05 plus owner-authorized read-only TestServer/TicketBot checks.

## Production SMP coverage

Fresh SMP inventory:

- 102 deployed plugin JARs.
- JAR SHA-256, size, mtime, plugin metadata, declared dependencies, commands and permissions captured.
- Fresh matching startup/runtime log inspected.
- Safe live configuration inspected for the major first-party/player-facing systems.
- Current runtime degradations are separated from source intent and config intent.

First-party/ecosystem source coverage:

- 29 deployed first-party/ecosystem plugin identities were classified.
- 23 already map to an existing source-registry project.
- 4 additional canonical repositories were identified and must be added to current-source collection:
  - `BadgersMC/EnthusiaAdvancements`
  - `BadgersMC/EnthusiaBiomes`
  - `BadgersMC/EnthusiaGiveaway`
  - `BadgersMC/LumaTrivia`
- 2 deployed first-party plugins remain source-unresolved:
  - `EnthusiaDisplay`
  - `EnthusiaMapShields`

Do not invent repositories for unresolved plugins. Their deployed JAR/config/runtime evidence remains valid CURRENT runtime evidence, while source-derived facts stay unavailable until provenance is found.

## Confirmed stale source-registry mappings

The existing bootstrap registry is stale for three production systems:

- EnthusiaExpress:
  - stale: `wsg138/Enthusia-Express`
  - production/canonical current source: `FainNeito/Enthusia-Express`
- LumaGuilds:
  - stale: `wsg138/LumaGuilds`
  - production/canonical current source: `BadgersMC/LumaGuilds`
- EnthusiaMarket:
  - stale: `wsg138/EnthusiaMarket`
  - production/canonical current source: `BadgersMC/EnthusiaMarket`

The other configured forks were reviewed rather than mechanically replaced. Some are intentionally ahead of their parents. RoseChat currently has divergent history but zero content differences between the configured fork and synchronized parent.

## Network target freshness

### SMP

Status: **FRESH / CURRENT**

- direct read-only mirror evidence current;
- runtime log current;
- production JAR inventory current.

### TestServer

Status: **FRESH / TEST-ONLY**

- owner's saved TestServer SFTP identity authenticates read-only;
- 97 plugin JARs inventoried directly;
- production and TestServer differ materially;
- TestServer must never outrank SMP for current player-facing facts.

### TicketBot

Status: **FRESH DEPLOYMENT CHECK**

- owner's saved TicketBot SFTP identity authenticates read-only;
- merged internal Ticket API code is not on the live filesystem;
- classification: MERGED, NOT DEPLOYED.

### Hub / Velocity / Test2 / Build / Sentinel

Status: **STALE / NOT CURRENT**

The existing all-server GitHub mirror credentials for these targets were failing authentication during the current audit window. September snapshots must not be represented as current.

Until refreshed:

- use them only as historical/development evidence;
- never answer volatile/current state from them;
- mark current target state unknown when no fresher authority exists.

## Standing live gateway credential state

The audit was owner-authorized read-only.

Important distinction:

- current saved SFTP identities were used only for read operations during this audit;
- that does not prove the underlying accounts are server-side restricted to read-only;
- the permanent AI live-source gateway should still use a dedicated read-only identity or equivalent proven server-side restrictions.

## Runtime unknowns that remain

- exact source/build provenance for EnthusiaDisplay;
- exact source/build provenance for EnthusiaMapShields;
- exact canonical source for local PoseProbe diagnostic plugin;
- current Hub/Velocity/other stale-target inventories;
- external reachability of services such as LumaGuilds Web API has not been tested merely because local config says they listen.

## Retrieval precedence

For volatile/current questions:

1. fresh verified runtime/deployment evidence;
2. exact deployed-artifact provenance;
3. fresh canonical source/config evidence;
4. current structured memory;
5. generic model knowledge.

Never infer:

- GitHub main = production;
- merged = deployed;
- configured enabled = runtime integration healthy;
- TestServer = newer;
- matching filename = matching binary.
