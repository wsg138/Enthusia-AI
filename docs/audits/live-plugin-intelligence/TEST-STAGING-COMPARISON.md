# TestServer staging comparison

Captured through the owner's existing saved TestServer SFTP session on 2026-10-05.

Classification: **TEST_ONLY_NOT_PRODUCTION_TRUTH**

## Freshness

- Direct read-only SFTP authentication succeeds.
- 97 plugin JARs are currently present on TestServer.
- The GitHub all-server mirror's TestServer credential is stale/incorrect; that workflow failure is not evidence that the server itself is inaccessible.
- This source may be used for staging/debug comparisons only.
- It must never override the fresh SMP deployment/runtime evidence for player-facing answers.

## First-party comparison against current SMP

| System | Production SMP | TestServer | Interpretation |
|---|---|---|---|
| EnthusiaAdvancements | `pilot.6-discord-test.3` | `pilot.6-discord-test.1` | Test is older |
| EnthusiaBiomes | `1.0.1-26.2-test.1` | same filename | Requires hash check before claiming exact equality |
| EnthusiaCommend | `2.14.0-advancement-evidence-test.1` | `2.14.0-test5-advancements-42476c4` | Different builds |
| EnthusiaCurrency | `1.4.4-moderation-api` | same filename | Requires hash check before exact equality |
| EnthusiaDisplay | `0.1.8-test` | `0.1.3-test` | Test is older |
| EnthusiaDonorNPCs | `1.0.16` | same filename | Requires hash check before exact equality |
| EnthusiaDonors | `1.1.0-test.15` | `1.1.0-test.5` | Test is older |
| EnthusiaExpress | `1.2.1` | `1.2.1-mapart-test.4-26.2` | Different builds |
| EnthusiaFrontier | `0.1.1` | not present | Production-only in current comparison |
| EnthusiaGiveaway | `0.1.4` | same filename | Requires hash check before exact equality |
| EnthusiaKOTH | `0.1.0-SNAPSHOT` | same filename | Filename alone is not identity |
| EnthusiaLoreItems | `1.0.2-tps-test.2` | generic `EnthusiaLoreItems.jar` | Different/ambiguous |
| EnthusiaMapShields | `0.1.4` | `0.1.2` | Test is older |
| EnthusiaMarket | `1.0.52` | same filename | Requires hash check before exact equality |
| EnthusiaPlaytime | `3.7.2-discord-sync-test3` | not found under current production-style filename | Test differs |
| EnthusiaServerAutoClicker | generic production filename | same filename | Filename alone is not identity |
| EnthusiaStaff | `EnthusiaStaff-Paper.jar` | same filename | Likely related deployment; do not assume equality without hash proof |
| EnthusiaStaffAuthorityBridge | present on SMP | not present | Production-only in current comparison |
| EnthusiaTags | `2.2.2-unique-mail-test.1` | `2.2.2-supporter-test.10` | Different builds |
| EnthusiaTeleport | `1.2.9` | same filename | Requires hash check before exact equality |
| EnthusiaToiletFlush | `9.8.8` companion | same filename | Requires hash check before exact equality |
| EnthusiaVotes | `v0.1.23` | same filename | Requires hash check before exact equality |
| LumaGuilds | `3.0.20` | `3.0.4-enthusia-gui.5` | Test is substantially behind production |
| RoseChat | `RC-4` | same filename | Same name does not prove same artifact |

## Important lesson for retrieval

Test/staging is not inherently newer than production.

When answering a current player question:

1. prefer verified production SMP state;
2. use TestServer only for debugging, pending rollout context, or explicitly requested staging comparison;
3. never promote a TestServer behavior to current production truth without matching deployment evidence;
4. if the same filename appears on both targets, compare hash/source provenance before claiming equality.

## Credential note

The TestServer saved local SFTP identity works for read-only inspection. The GitHub Actions secret used by the all-server mirror should be treated as stale until separately repaired. No credential value is stored in this audit.
