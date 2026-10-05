# SMP integration and dependency graph

Evidence: deployed JAR metadata plus the fresh 2026-10-05 SMP startup/runtime log.

## Interpretation

- Hard dependency: declared required plugin relationship in deployed metadata.
- Soft dependency: plugin can integrate when the target is present; this alone does not prove the integration is active.
- Runtime confirmed: startup/runtime evidence proves the hook or integration actually activated.
- Runtime degraded/disabled: code/plugin exists, but live evidence shows the feature is unavailable or intentionally disabled.

## Core declared edges

| Source | Type | Target | Target installed? |
|---|---|---|---|
| DiscordSRV | soft | Vault | yes |
| DiscordSRV | soft | PlaceholderAPI | yes |
| DiscordSRV | soft | LuckPerms | yes |
| EnthusiaCommend | hard | Vault | yes |
| EnthusiaCommend | soft | PlaceholderAPI | yes |
| EnthusiaCommend | soft | EnthusiaTeleport | yes |
| EnthusiaCommend | soft | ProtocolLib | yes |
| EnthusiaCommend | soft | WarzoneDuels | yes |
| EnthusiaCommend | soft | Plan | no |
| EnthusiaCurrency | hard | Vault | yes |
| EnthusiaCurrency | soft | PlaceholderAPI | yes |
| EnthusiaCurrency | soft | Plan | no |
| EnthusiaDisplay | hard | UnlimitedNameTags | yes |
| EnthusiaDisplay | hard | PlaceholderAPI | yes |
| EnthusiaDisplay | soft | RoseChat | yes |
| EnthusiaExpress | soft | Vault | yes |
| EnthusiaExpress | soft | EnthusiaCurrency | yes |
| EnthusiaPlaytime | soft | Plan | no |
| EnthusiaPlaytime | soft | PlaceholderAPI | yes |
| EnthusiaPlaytime | soft | ProtocolLib | yes |
| EnthusiaPlaytime | soft | DiscordSRV | yes |
| EnthusiaStaffAuthorityBridge | hard | LuckPerms | yes |
| EnthusiaStaffAuthorityBridge | soft | DiscordSRV | yes |
| EnthusiaStaff | soft | ProtocolLib | yes |
| EnthusiaStaff | soft | DiscordSRV | yes |
| EnthusiaStaff | soft | LuckPerms | yes |
| EnthusiaStaff | soft | EnthusiaCurrency | yes |
| EnthusiaStaff | soft | EnthusiaMarket | yes |
| EnthusiaStaff | soft | EnthusiaCommend | yes |
| EnthusiaStaff | soft | EnthusiaTeleport | yes |
| EnthusiaStaff | soft | EnthusiaPlaytime | yes |
| EnthusiaTags | soft | WarzoneDuels | yes |
| EnthusiaTags | soft | EnthusiaCommend | yes |
| EnthusiaTags | soft | EnthusiaExpress | yes |
| EnthusiaTags | soft | RoseChat | yes |
| EnthusiaTags | soft | PlaceholderAPI | yes |
| EnthusiaTags | soft | LuckPerms | yes |
| EnthusiaTags | soft | UnlimitedNametags | yes |
| EnthusiaTags | soft | Vault | yes |
| EnthusiaTags | soft | EnthusiaCurrency | yes |
| EnthusiaTags | soft | EnthusiaPlaytime | yes |
| InteractiveChat | hard | PlaceholderAPI | yes |
| InteractiveChat | hard | Vault | yes |
| InteractiveChat | soft | DiscordSRV | yes |
| InteractiveChat | soft | LuckPerms | yes |
| InteractiveChat | soft | ProtocolLib | yes |
| InteractiveChatDiscordSrvAddon | hard | InteractiveChat | yes |
| InteractiveChatDiscordSrvAddon | hard | DiscordSRV | yes |
| LumaGuilds | hard | RoseChat | yes |
| LumaGuilds | soft | Vault | yes |
| LumaGuilds | soft | PlaceholderAPI | yes |
| LumaGuilds | soft | EnthusiaPlaytime | yes |
| LumaGuilds | soft | packetevents | yes |
| LumaGuilds | soft | DiscordSRV | yes |
| RoseChat | soft | Vault | yes |
| RoseChat | soft | PlaceholderAPI | yes |
| RoseChat | soft | DiscordSRV | yes |
| RoseChat | soft | ProtocolLib | yes |
| RoseChat | soft | LuckPerms | yes |
| RoseChat | soft | InteractiveChat | yes |
| UnlimitedNameTags | hard | packetevents | yes |
| UnlimitedNameTags | soft | PlaceholderAPI | yes |
| UnlimitedNameTags | soft | ProtocolLib | yes |
| WarzoneDuels | soft | Vault | yes |
| WarzoneDuels | soft | EnthusiaTeleport | yes |
| WarzoneDuels | soft | EnthusiaTags | yes |
| WarzoneDuels | soft | Plan | no |
| packetevents | soft | ProtocolLib | yes |

## Runtime-confirmed active integrations

- EnthusiaExpress -> EnthusiaCurrency — Express bound Currency 1.4.4 moderation API v1 for mail movement leases.
- EnthusiaCommend -> EnthusiaTeleport — startup explicitly reports the plugins linked.
- LumaGuilds -> RoseChat — /g chat is wired to the RoseChat guild channel; cleanup integration registered and guild/ally/modchat channels registered.
- LumaGuilds -> DiscordSRV — DiscordSRV account-link and guild-profile listeners are subscribed; public guild slash commands registered. Startup initially waits for DiscordReadyEvent before guild-role reconciliation.
- LumaGuilds -> Apollo — Apollo/Lunar Client integration is enabled, including vault location beams and guild rich presence.
- InteractiveChat -> DiscordSRV — runtime explicitly reports the hook active.
- InteractiveChat -> ViaVersion / LuckPerms / floodgate — runtime explicitly reports all three hooks active.
- InteractiveChatDiscordSrvAddon -> DiscordSRV — inbound/outbound and ready listeners are registered.
- InteractiveChatDiscordSrvAddon -> ImageFrame — runtime explicitly reports the ImageFrame hook active.
- UnlimitedNameTags -> PacketEvents — runtime explicitly reports the hook active.
- DiscordSRV -> LuckPerms / PlaceholderAPI / Multiverse-Core — runtime initialization explicitly enables these hooks.
- WarzoneDuels -> CombatLogX — runtime explicitly reports combat-tag integration active.

## Runtime-degraded or disabled integrations/features

- EnthusiaTags -> RoseChat presence API: DEGRADED. Current RoseChat artifact lacks PresenceMessageEvent; Tags falls back to RoseChat audience/default behavior. Tracked in issue #36.
- EnthusiaStaff -> ProtocolLib fake-entity cheat tester: DEGRADED / FAIL-CLOSED. Runtime adapter throws inside ProtocolLib and fake-entity evidence collection disables itself. Evidence attached to EnthusiaStaff issue #236.
- LumaGuilds claims: DISABLED. Startup states Claims system disabled - all claim features unavailable. Do not answer players as if guild claims are currently enabled.
- LumaGuilds -> AxKoth: UNAVAILABLE. Startup reports AxKoth not found.
- WarzoneDuels -> Plan: UNAVAILABLE. Startup reports Plan extension integration could not start because DataExtension is unavailable; WarzoneDuels continues without it.
- InteractiveChatDiscordSrvAddon resource-pack fetch: DEGRADED. It failed to download the server resource pack and fell back to loading Default plus local pack.zip resources.
- EnthusiaAdvancements -> InteractiveChatDiscordSrvAddon icon rendering: DEGRADED. A live advancement icon render throws an NPE in the addon's item-model resolution path. This affects Discord advancement icon rendering, not the entire chat bridge.

## Important authority / player-visibility notes

- A declared command or dependency is not automatically player-facing.
- EnthusiaStaff has a large staff-only command surface. Normal player help should expose only player-relevant flows such as reporting/account linking when appropriate, not moderation/admin syntax.
- DiscordSRV is still actively present and used by multiple integrations today. Replacing it requires migration of those active edges, not simply deleting the JAR.
- Plan is not present in the fresh installed plugin inventory even though several plugins declare it as a soft dependency. Treat Plan-backed features as unavailable unless another network target/runtime source proves otherwise.
- Current RoseChat presence degradation means any AI answer about Tags/RoseChat presence should describe the fallback/current state rather than intended source behavior.

## Machine-readable graph

data/SMP-DECLARED-DEPENDENCY-GRAPH.json contains every hard/soft dependency declaration from all 102 deployed JARs, with installed-target resolution where exact plugin names match.
