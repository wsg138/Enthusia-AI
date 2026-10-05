# Live Plugin Intelligence Audit — SMP baseline

Status: initial evidence-backed baseline; direct standing Enthusia-AI SFTP gateway not yet enabled.

## Evidence source

- Source repository: `wsg138/Enthusia-Server`
- Snapshot commit: `28b0fc262c0bcb17324e03eb2eb0b13945ceaf27`
- Snapshot time: `2026-10-04T18:06:04.9127438Z`
- Server ID: `main`
- Reported target: Minecraft 26.2 / Leaf 26.2 build 37 / Java 25
- Inventory source: `reports/network/SMP/plugin-jars.csv`
- Plugin JAR count: **101**
- First-party-named `Enthusia*` JAR count: **22**

This snapshot is a sanitized one-way SFTP mirror. It is strong deployment evidence for the recorded time, but it is not proof of process/runtime enablement for every JAR. Runtime-enabled state should be verified separately where needed.

## Production filenames requiring classification

The following deployed filenames contain test/pilot/dev/RC/SNAPSHOT/PR/copy-style qualifiers. This is **not** automatically a problem: several may be intentionally promoted test-labeled builds. The audit must map each exact hash to its source/build and determine whether the filename reflects the approved production artifact or stale/temporary deployment.

- `EnthusiaAdvancements-pilot.6-discord-test.3.jar`
- `EnthusiaBiomes-1.0.1-26.2-test.1.jar`
- `EnthusiaCommend-2.14.0-advancement-evidence-test.1.jar`
- `EnthusiaDisplay-0.1.6-test.jar`
- `EnthusiaDonors-1.1.0-test.15.jar`
- `EnthusiaExpress-1.2.1-PR7-bulk-read-testing.jar`
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
- `ProtocolLib-26.2-dev.jar`
- `RoseChat-RC-4-presence-26.2-test.5.jar`
- `UltimateAdvancementAPI-Plugin-2.8.1-loading-guard-test.1.jar`
- `VoidGen-2.3.8 (1).jar`

## Current network freshness

At coordinator check time:

- Main/SMP SFTP authentication was working and the October 4 snapshot was current enough for the initial baseline.
- Hub, Velocity, Build, Test, Test2, and Sentinel existing snapshots were dated September 18.
- The previous all-server workflow showed SFTP authentication failures for those six targets.
- Those six snapshots must be marked **STALE** until refreshed; they must not be used as current deployment truth.
- A new owner-authorized all-server read-only mirror run was started as GitHub Actions run `37271772766`.

## Credential boundary

Existing MainServer connection information is stored outside source control in saved FileZilla/rclone configuration and GitHub Actions secrets. The existing mirror performs only read operations against production.

However, the saved MainServer identity appears to be the normal Pterodactyl SFTP account. Read-only *workflow behavior* does not prove the account itself is server-side write-restricted.

For the permanent Enthusia-AI live gateway, keep the stronger requirement:

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
