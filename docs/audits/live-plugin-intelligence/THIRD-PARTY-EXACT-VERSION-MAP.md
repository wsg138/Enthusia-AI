# Prioritized third-party exact-version research map

This map covers third-party plugins that materially affect player/support answers, cross-plugin behavior or current runtime compatibility.

Status meanings:

- **EXACT RELEASE VERIFIED** — deployed version maps to an official release/version record.
- **OFFICIAL VERSION SOURCE VERIFIED** — official project/version evidence exists, but this audit has not byte-matched the deployed JAR.
- **EXACT BUILD UNRESOLVED** — official project is known, but the precise snapshot/build was not independently mapped.

## Exact/official version evidence

| Plugin | Deployed version | Status | Current evidence |
|---|---:|---|---|
| DiscordSRV | 1.30.5 | EXACT RELEASE VERIFIED | Official GitHub v1.30.5 release; includes a Minecraft 26.x GameProfile fix. |
| PlaceholderAPI | 2.12.3 | EXACT RELEASE VERIFIED | Official 2.12.3 release includes 26.2 support/fixes. |
| ViaVersion | 5.12.0 | EXACT RELEASE VERIFIED | Official GitHub 5.12.0 release. |
| ViaBackwards | 5.12.0 | EXACT RELEASE VERIFIED | Official GitHub 5.12.0 release. |
| LuckPerms | 5.5.85 | OFFICIAL VERSION SOURCE VERIFIED | Official LuckPerms package registry exposes v5.5.85. |
| TAB | 6.2.0 | EXACT RELEASE VERIFIED | Official 6.2.0 release; 26.2 remains supported while 26.3 support was added. |
| CoreProtect | 24.1 | EXACT RELEASE VERIFIED | Official CoreProtect CE v24.1 release adds Minecraft 26.2 support. |
| FastAsyncWorldEdit | 2.15.4+d8666b3 | EXACT RELEASE VERIFIED | Official FAWE 2.15.4 release commit d8666b3 matches the deployed embedded build suffix. |
| Multiverse-Core | 5.8.1 | EXACT RELEASE VERIFIED | Official GitHub 5.8.1 release. |
| WorldGuard | 7.0.19+2400-f395a16 | OFFICIAL VERSION SOURCE VERIFIED | Official 7.0.x changelog states 7.0.19 requires 26.2+. Exact build suffix not independently byte-matched. |
| Nexo | 1.28 | EXACT RELEASE VERIFIED | Official Nexo changelog/repository lists stable v1.28 released 2026-09-05. |
| floodgate | 2.2.5-SNAPSHOT b141-81b65cc | OFFICIAL VERSION SOURCE VERIFIED | Official Floodgate API docs use 2.2.5-SNAPSHOT; public 26.2 evidence shows build b141-81b65cc. Exact artifact not byte-matched. |
| ProtocolLib | 5.5.0-SNAPSHOT-583353e | EXACT BUILD UNRESOLVED | Official source declares 5.5.0-SNAPSHOT for MC 26.2. The deployed build suffix was not mapped to an immutable release artifact. |
| InteractiveChat | 2026.1.1.0 | EXACT BUILD UNRESOLVED | Official repo verified; docs confirm ProtocolLib/PlaceholderAPI/Vault dependencies and DiscordSRV/LuckPerms/ViaVersion integrations. Exact artifact not independently mapped. |
| InteractiveChatDiscordSrvAddon | 2026.1.1.0 | EXACT BUILD UNRESOLVED | Official repo verified; documented dependencies include InteractiveChat and DiscordSRV. Exact artifact not independently mapped. |
| ImageFrame | 2026.1.5.0 | EXACT BUILD UNRESOLVED | Official repo/Jenkins distribution verified; no immutable GitHub release matching this exact version surfaced. |
| FancyNpcs | 2.12.1 | EXACT BUILD UNRESOLVED | Historical standalone repo is archived and points to the FancyInnovations monorepo; exact 2.12.1 provenance still needs resolution there. |
| Chunky | 1.5.3 | EXACT BUILD UNRESOLVED | Official pop4959/Chunky repo verified; project does not publish GitHub releases, so exact distribution must be resolved through its normal download channel. |
| simple voice chat | 2.6.24 | EXACT BUILD UNRESOLVED | Official project verified; GitHub is source-only and normal binary distribution is external. |
| CombatLogX | 11.6.0.0.1286 | EXACT BUILD UNRESOLVED | Official project/build channel still needs a direct build match before version-specific behavior beyond live runtime/config is treated as authoritative. |

## Current live evidence outranks public docs

Even when an exact public release is verified, current Enthusia configuration/runtime decides enabled behavior.

Examples:

- DiscordSRV being installed does not mean every role-link migration is authoritative; EnthusiaStaffAuthorityBridge currently treats DiscordSRV as read-only transition input.
- PlaceholderAPI expansions can fail independently; current runtime reports missing legacy expansions for plugins not installed.
- ProtocolLib being loaded does not make every packet adapter healthy; EnthusiaStaff's fake-entity adapter currently fails closed.
- InteractiveChatDiscordSrvAddon is loaded, but its resource-pack path currently falls back after a remote pack download failure.
- CoreProtect version support does not imply retention/database configuration should be inferred from public defaults.

## Official-source references used in this pass

- DiscordSRV GitHub releases.
- PlaceholderAPI GitHub releases.
- ViaVersion and ViaBackwards GitHub releases.
- LuckPerms official GitHub package registry.
- NEZNAMY/TAB GitHub releases.
- PlayPro/CoreProtect GitHub releases/source.
- IntellectualSites/FastAsyncWorldEdit GitHub releases.
- Multiverse/Multiverse-Core GitHub releases.
- EngineHub/WorldGuard 7.0.x changelog.
- NexoMC official changelog/Maven repository.
- GeyserMC Floodgate source/API documentation.
- dmulloy2/ProtocolLib source.
- LOOHP InteractiveChat, InteractiveChat DiscordSRV Addon and ImageFrame repositories.
- FancyNpcs official repository migration notice.
- pop4959/Chunky official repository.
- henkelmax/simple-voice-chat official repository.

Do not broaden version-specific claims from generic docs when the deployed exact build remains unresolved.
