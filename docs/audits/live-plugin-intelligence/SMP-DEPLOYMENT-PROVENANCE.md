# SMP deployment provenance — verified changed/current builds

Evidence snapshot: `wsg138/Enthusia-Server@b5bd154c4d28a3e935239778ca8999b8ca74e83a` (2026-10-05 06:37 UTC).

This file records source/build provenance separately from runtime configuration. A deployed filename/version is not treated as proof of source commit.

## Enthusia Express

Production:

- file: `EnthusiaExpress-1.2.1.jar`
- SHA-256: `2be85bcaf29c1df266c480fdba700b0e579a12abfa03afad1430f1a674e5aad2`
- size: 16,600,971 bytes

Verified source/build:

- canonical upstream repo: `FainNeito/Enthusia-Express`
- main commit: `d5c519455ce7429e0e939762ca583d4fb774e543`
- commit: `fix: treat hidden mail recipients as offline to their sender (#8)`
- CI run: `37248190743`
- artifact: `EnthusiaExpress-testing-jar`
- artifact JAR SHA-256: `2be85bcaf29c1df266c480fdba700b0e579a12abfa03afad1430f1a674e5aad2`

Result: **VERIFIED exact byte-for-byte CI artifact match**.

The local `wsg138/Enthusia-Express` fork is stale and must not be treated as current source authority for this deployment.

## LumaGuilds

Production:

- file: `LumaGuilds-3.0.20.jar`
- SHA-256: `8894415da0046a9ee100c186ec5306522be218408c09e18e655f4a07fb2dd2be`
- size: 24,946,684 bytes

Closest verified source/build:

- repo: `BadgersMC/LumaGuilds`
- source commit: `e90bbb53f5b3b7a7b37b61c938f56d3e8abfc5cf`
- CI build run: `37244444547`
- CI artifact JAR SHA-256: `c1854d85c50b0c96be551c7e6394ab2caa5d00468f0171b339045279016e50fe`

ZIP entry comparison shows **every entry is identical except `plugin.yml`**. The only content difference in that file is:

```diff
-version: 3.0.0
+version: 3.0.20
```

Result: **VERIFIED same executable/resource code as commit `e90bbb53...`, with a post-build embedded version metadata edit**.

Do not equate current LumaGuilds main (`439681af...`) with the deployed artifact; later commits were merged after this production JAR was built.

Current live config additionally has:

- `chapter_two_gold_costs_enabled: true`
- `home_activation_base_cost: 100`
- `home_activation_scale: 1.0`

The source formula is `base * scale^(homeOrdinal - 1)`, rounded upward. With the current values, every newly activated guild home costs 100 while Chapter 2 gold costs remain enabled.

## RoseChat

Current production:

- file: `RoseChat-RC-4.jar`
- SHA-256: `d3b7a0c9853e0bac657ab709a2c020d1eb466ec2ddd88276230ab41fd6daae35`
- missing `PresenceMessageEvent.class`

Known-good current source build:

- repo: `wsg138/Enthusia-RoseChat`
- current master commit at verification: `cd0290b4b48aea99110a746e319e5c906701b273`
- CI run: `37149015161`
- CI artifact SHA-256: `6ab9771f477ad8ad6021ff7efaae33051640a0b31e85c9c41b923b585def0ea2`
- contains `PresenceMessageEvent.class`

The exact `6ab977...` artifact was also the prior production `RoseChat-RC-4-presence-26.2-test.5.jar`.

Result: **CONFIRMED current production artifact mismatch**. The deployed `d3b7...` JAR is not the current presence-capable master build and causes EnthusiaTags to log a presence-hook fallback. Tracked in Enthusia-AI issue #36.

## EnthusiaStaff Paper

Current production:

- file: `EnthusiaStaff-Paper.jar`
- SHA-256: `c4c04c1f8b64ce53eb0d7eb88f719a2c8d03739dbe9589623babe9dc0e7ce23a`

Exact source/build provenance was located in the owner's local development tree:

- worktree: `EnthusiaStaff-network-ready`
- source HEAD: `27f8b1a3590cfc730ef61f13533484eb0fb12fcc`
- prior local commit: `1cb2cd7a`
- base: `93e81ca1d4a1d2ce4f1199c91130bb7963093dcc`
- built local JAR SHA-256: exact `c4c04c...` match

At discovery, the two commits ahead of `93e81ca1` existed only locally and were absent from GitHub. The exact source HEAD has therefore been preserved unchanged on:

`wsg138/EnthusiaStaff:preserve/prod-network-ready-20261003`

This preservation is **not** a merge recommendation. Current main has advanced and may contain supersets/equivalents.

Tracked in EnthusiaStaff issue #332.

## PoseProbe

Production:

- file: `PoseProbe-0.1.0-local-diagnostic.jar`
- SHA-256: `6c45d1af007aa3050b1d5c87f090559bbfa39846c3d21f7236076323eddb1b8e`
- main class: `dev.enthusia.diagnostics.PoseProbe`
- depends on ProtocolLib
- command: console-only `/poseprobe`
- description: “Console-only 30-second pose observer”

Runtime logs confirm the plugin is loaded/enabled.

No canonical source repository/commit has yet been identified.

Result: **UNRESOLVED provenance / production-cleanup candidate**. Do not expose it as a normal player-facing capability.

## Confidence legend

- **VERIFIED exact** — production SHA equals a known CI/source artifact SHA.
- **VERIFIED same code + metadata edit** — every JAR entry matches a known source build except documented metadata-only content.
- **CONFIRMED mismatch** — runtime artifact is proven different from the required/current source build and runtime impact is observed.
- **UNRESOLVED** — production file is observed, but exact source/build origin is not yet proven.
