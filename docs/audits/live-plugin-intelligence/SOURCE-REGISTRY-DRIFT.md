# Source registry drift audit

Evidence collected 2026-10-05 while reconciling the source-grounded training registry against fresh production deployment provenance.

## Why this matters

The synthetic/RAG source registry must not assume that a repository with the right project name is the source of the currently deployed build.

A fork can be:

- the canonical Enthusia-maintained source;
- intentionally ahead of its parent;
- stale while development moved to the parent;
- content-equivalent despite divergent Git history.

Production artifact hashes and source ancestry decide current authority.

## Confirmed registry corrections

### EnthusiaExpress

Configured source:

- `wsg138/Enthusia-Express`
- fork head: `66786088c3988478afe34518d779694b00d882b1`
- head date: 2026-09-12

Canonical/current source:

- `FainNeito/Enthusia-Express`
- head: `d5c519455ce7429e0e939762ca583d4fb774e543`
- head date: 2026-10-05

Production proof:

- deployed `EnthusiaExpress-1.2.1.jar`
- SHA-256 `2be85bcaf29c1df266c480fdba700b0e579a12abfa03afad1430f1a674e5aad2`
- exact byte-for-byte match to upstream CI run `37248190743` at `d5c519455...`

Classification: **configured source stale; use FainNeito upstream for current production-grounded retrieval**.

### LumaGuilds

Configured source:

- `wsg138/LumaGuilds`
- fork head: `daedf8cbdc2374ad34a7a5dc5938351cbffde548`
- head date: 2026-09-18

Canonical/current source:

- `BadgersMC/LumaGuilds`
- current head at audit: `439681af6e828efb8df7b9bd7625658eedc6353b`

Production proof:

- deployed `LumaGuilds-3.0.20.jar`
- SHA-256 `8894415da0046a9ee100c186ec5306522be218408c09e18e655f4a07fb2dd2be`
- executable/resource contents match upstream commit `e90bbb53f5b3b7a7b37b61c938f56d3e8abfc5cf`, with only the documented embedded `plugin.yml` display-version edit from 3.0.0 to 3.0.20.

The parent has more than 100 commits after the registered fork diverged, including the current Chapter 2, banking, war, Discord-role, menu and other systems observed in production.

Classification: **configured source materially stale; use BadgersMC upstream for current production-grounded retrieval**.

### EnthusiaMarket

Configured source:

- `wsg138/EnthusiaMarket`
- fork head: `cc19fa966dcb155fa1743f5076fb5152e74bdf8f`
- head date: 2026-08-26

Canonical/current production source:

- `BadgersMC/EnthusiaMarket`
- release `v1.0.52`

Production proof:

- deployed `EnthusiaMarket-1.0.52.jar`
- SHA-256 `1c7dee48dbe060a826a00ca85d828b656bd690e88387e9a49da031e7425d0483`
- size 3,984,922 bytes
- BadgersMC release asset has the exact same SHA-256 and size.

Classification: **configured source stale for current production; use BadgersMC upstream for production-grounded retrieval**.

## Forks that should not be mechanically replaced

The source registry contains ten forks total. The remaining forks do not currently justify automatic replacement simply because a parent exists.

### Enthusia-RoseChat

Configured fork:

- `wsg138/Enthusia-RoseChat@cd0290b4...`

Parent:

- `BadgersMC/Enthusia-RoseChat@0f88bbda...`

Git histories are divergent, but the comparison at audit time reports **zero changed files**. The parent contains synchronization history from the Enthusia fork.

Classification: **content-current; retain the intentional Enthusia fork unless source ownership policy changes**.

This is separate from the current production deployment regression: production is running a different/older RC-4 binary even though the source tree is current.

### EnthusiaDonor

- configured fork `wsg138/EnthusiaDonor` is newer than `NotBorlyn/EnthusiaDonor`.
- retain configured Enthusia fork.

### EnthusiaDonorNPCs

- configured fork `wsg138/EnthusiaDonorNPCs` is newer than `NotBorlyn/EnthusiaDonorNPCs`.
- retain configured Enthusia fork.

### EnthusiaToiletFlush

- configured fork is newer than the BadgersMC parent.
- retain configured Enthusia fork unless deployment provenance proves otherwise.

### EnthusiaVotes

- configured fork is newer than the BadgersMC parent.
- retain configured Enthusia fork unless deployment provenance proves otherwise.

### enthusia-support-bot

- configured `wsg138/enthusia-support-bot` is the active Enthusia development line and is substantially ahead of the NotBorlyn parent.
- retain configured Enthusia fork.

### gatekeeper

- configured Enthusia fork is newer than its parent.
- no current evidence justifies replacing it.

## Training/RAG consequence

Before the next owner-review synthetic generation gate:

1. canonicalize current-source collection for Express, LumaGuilds and Market;
2. refresh source collection for those repositories;
3. re-run secret/source QA;
4. rebuild the affected sanitized RAG and synthetic-grounding corpus;
5. ensure stale fork content cannot outrank the production-matched canonical source;
6. preserve explicit provenance so future retrieval can distinguish development forks from production source authority.

Do not run the owner 10-example gate from a corpus still grounded on the stale Express/LumaGuilds/Market forks.
