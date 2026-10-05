# Live Plugin Intelligence Audit — SMP baseline

Status: fresh read-only production baseline captured; direct standing Enthusia-AI SFTP gateway not yet enabled.

## Evidence source

- Source repository: `wsg138/Enthusia-Server`
- Snapshot commit: `b5bd154c4d28a3e935239778ca8999b8ca74e83a`
- Snapshot time: `2026-10-05T06:37:02Z`
- Server ID: `main`
- Runtime log reports: Minecraft 26.2 / Paper 26.2-129 (`9240f58`) / Java 25
- Inventory source: `reports/network/SMP/plugin-jars.csv`
- Plugin JAR count: **102**
- First-party-named `Enthusia*` JAR count: **22**

The snapshot is produced by a one-way sanitized Bloom SFTP mirror. It is strong evidence for the deployed file state at the recorded time. Runtime startup logs from the same snapshot are used separately to distinguish “JAR exists” from “plugin loaded/enabled.”

## Change since the prior 2026-10-04 snapshot

Added/replaced in production:

- `EnthusiaDisplay-0.1.8-test.jar` — SHA-256 `0580897457291b7d6f9dd0176b2604a090e07c321632bfdc4d5345c5c349f0d9`
- `EnthusiaExpress-1.2.1.jar` — SHA-256 `2be85bcaf29c1df266c480fdba700b0e579a12abfa03afad1430f1a674e5aad2`
- `LumaGuilds-3.0.20.jar` — SHA-256 `8894415da0046a9ee100c186ec5306522be218408c09e18e655f4a07fb2dd2be`
- `PoseProbe-0.1.0-local-diagnostic.jar` — SHA-256 `6c45d1af007aa3050b1d5c87f090559bbfa39846c3d21f7236076323eddb1b8e`
- `RoseChat-RC-4.jar` — SHA-256 `d3b7a0c9853e0bac657ab709a2c020d1eb466ec2ddd88276230ab41fd6daae35`

Removed/replaced:

- `EnthusiaDisplay-0.1.6-test.jar`
- `EnthusiaExpress-1.2.1-PR7-bulk-read-testing.jar`
- `LumaGuilds-3.0.17.jar`
- `RoseChat-RC-4-presence-26.2-test.5.jar`

Changed under the same filename:

- `EnthusiaStaff-Paper.jar`: old SHA `b612d44...` -> current SHA `c4c04c1f8b64ce53eb0d7eb88f719a2c8d03739dbe9589623babe9dc0e7ce23a`

## Runtime confirmation

The fresh startup log confirms the changed/new JARs actually loaded/enabled:

- EnthusiaDisplay `0.1.8-test`
- EnthusiaExpress `1.2.1`
- LumaGuilds `3.0.20`
- PoseProbe `0.1.0-local-diagnostic`
- RoseChat `RC-4`
- EnthusiaStaff `0.1.0-SNAPSHOT`

This means PoseProbe is not merely stale disk residue; it is an enabled production diagnostic plugin.

## Confirmed deployment regression — RoseChat / EnthusiaTags presence API

The prior production RoseChat JAR was:

- `RoseChat-RC-4-presence-26.2-test.5.jar`
- SHA-256 `6ab9771f477ad8ad6021ff7efaae33051640a0b31e85c9c41b923b585def0ea2`

That SHA exactly matches the successful CI artifact built from current `wsg138/Enthusia-RoseChat` master commit `cd0290b4b48aea99110a746e319e5c906701b273` (workflow run `37149015161`). The artifact contains:

`dev/rosewood/rosechat/api/event/PresenceMessageEvent.class`

Current production RoseChat:

- `RoseChat-RC-4.jar`
- SHA-256 `d3b7a0c9853e0bac657ab709a2c020d1eb466ec2ddd88276230ab41fd6daae35`
- does **not** contain `PresenceMessageEvent.class`

Current runtime warning:

`[EnthusiaTags] RoseChat presence hook unavailable; retaining RoseChat audience and defaults: dev.rosewood.rosechat.api.event.PresenceMessageEvent`

EnthusiaTags current source explicitly binds this event and its integration documentation requires the paired presence-capable RoseChat build.

Classification: **CONFIRMED deployment/build mismatch**. Track in Enthusia-AI issue #36. No production change is authorized by the audit.

## Confirmed runtime degradation — EnthusiaStaff fake-entity cheat-test path

Current production reports:

- EnthusiaStaff JAR SHA-256: `c4c04c1f8b64ce53eb0d7eb88f719a2c8d03739dbe9589623babe9dc0e7ce23a`
- ProtocolLib runtime: `5.5.0-SNAPSHOT-583353e` from `ProtocolLib-26.2-dev.jar`
- Paper: `26.2-129`

Runtime error:

`ProtocolLib fake-entity adapter failed; cheat-test fake entities are fail-closed`

The stack begins in ProtocolLib `AbstractStructure.getEnumEntityUseActions(...)`, reached from `ProtocolLibFakeEntityAdapter$1.onPacketReceiving(...:83)`.

Classification: **current feature degradation, safe/fail-closed**. Production evidence was attached to EnthusiaStaff acceptance issue #236. The fake-entity evidence path must not be treated as passing until real-Paper compatibility is fixed and retested.

## Diagnostic plugin cleanup candidate

`PoseProbe-0.1.0-local-diagnostic.jar` is currently deployed and enabled.

Embedded metadata:

- main class: `dev.enthusia.diagnostics.PoseProbe`
- depends on ProtocolLib
- exposes console-only `/poseprobe`
- description: “Console-only 30-second pose observer”

No normal player-facing purpose has been identified. Treat as a **production-cleanup candidate** unless an active investigation still requires it. Do not include it as ordinary player/server capability knowledge.

## Production filenames requiring classification

The following currently deployed filenames carry test/pilot/dev/RC/SNAPSHOT/copy/diagnostic qualifiers. This is not automatically a defect; exact hashes must be mapped to approved builds before classification.

- `EnthusiaAdvancements-pilot.6-discord-test.3.jar`
- `EnthusiaBiomes-1.0.1-26.2-test.1.jar`
- `EnthusiaCommend-2.14.0-advancement-evidence-test.1.jar`
- `EnthusiaDisplay-0.1.8-test.jar`
- `EnthusiaDonors-1.1.0-test.15.jar`
- `enthusiakoth-0.1.0-SNAPSHOT.jar`
- `EnthusiaLoreItems-1.0.2-tps-test.2.jar`
- `EnthusiaPlaytime-3.7.2-discord-sync-test3.jar`
- `EnthusiaTags-2.2.2-unique-mail-test.1.jar`
- `HeadDB-7.0.0-rc.7.jar`
- `InteractiveChat-2026.1.1.0 (1).jar`
- `InteractiveChatDiscordSrvAddon-2026.1.1.0 (1).jar`
- `LPX (1).jar`
- `maceguard-6.1.8-water-riptide-test.8.jar`
- `nuvotifier(1).jar`
- `papermcp-plugin-1.0.0-snapshot(1).jar`
- `PearlGlitchBlocker-1.0.0-SNAPSHOT.jar`
- `PieCloak-1.21.11-visibility-test.3-3084a56.jar`
- `PoseProbe-0.1.0-local-diagnostic.jar`
- `ProtocolLib-26.2-dev.jar`
- `RoseChat-RC-4.jar`
- `UltimateAdvancementAPI-Plugin-2.8.1-loading-guard-test.1.jar`
- `VoidGen-2.3.8 (1).jar`

## Current network freshness

Owner-authorized all-server read-only workflow run `37271772766` completed.

- Main/SMP authentication succeeded and produced the fresh 2026-10-05 snapshot.
- Test, Test2, Build, Hub, Velocity, and Sentinel all failed SFTP authentication.
- Their existing September 18 snapshots remain **STALE** and must not be used as current deployment truth.

The permanent audit must repair or replace those credentials before making current claims about those targets.

## Credential boundary

Existing MainServer connection information is stored outside source control in saved FileZilla/rclone configuration and GitHub Actions secrets. The mirror workflow performs reads only against production.

The currently saved MainServer identity appears to be the normal Pterodactyl SFTP account. Read-only workflow behavior does not prove the account itself is server-side write-restricted.

For the permanent Enthusia-AI live gateway, retain the stronger requirement:

1. dedicated server-side read-only identity, or documented proof of equivalent permission restriction;
2. pinned SSH host key;
3. runtime-only credential resolution;
4. model-visible output never receives host/user/authRef/password/private key;
5. no write/shell/restart/deploy operation exists in the gateway.

## Next SMP audit steps

1. Map every first-party deployed JAR hash to the exact GitHub repository/commit/build where possible.
2. Extract/verify plugin metadata and command/permission declarations.
3. Classify player-facing vs staff/backend commands.
4. Read sanitized live configuration for each plugin and record enabled/disabled behavior.
5. Research exact deployed versions of third-party plugins against authoritative sources.
6. Build dependency/integration edges.
7. Record unknown/conflicted/stale facts rather than guessing.
8. Produce canonical current plugin profiles with deployment provenance and freshness.
