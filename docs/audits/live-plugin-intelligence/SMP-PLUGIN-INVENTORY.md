# SMP deployed plugin inventory

Evidence: wsg138/Enthusia-Server at b5bd154c4d28a3e935239778ca8999b8ca74e83a, captured 2026-10-05 06:37 UTC.

All 102 JARs were read from production through the owner-authorized read-only SFTP path and re-hashed locally. Hash verification: 102/102 match the fresh mirror inventory; 0 mismatches.

This is STAFF/internal deployment evidence. Command declarations here are not automatically player-visible. Player-facing exposure must be decided from permission/default/config/runtime context.

| Plugin | Deployed JAR | Version | Manifest | Hard deps | Soft deps | Commands |
|---|---|---:|---|---|---|---|
| AutomaticBroadcast | AutomaticBroadcast-1.10.3.jar | 1.10.3 | plugin.yml |  | PlaceHolderAPI | /automaticbroadcast |
| AxiomPaper | AxiomPaperPlugin-6.0.1-for-MC26.2.jar | 6.0.1+26.2 | plugin.yml |  | CoreProtect, ViaVersion, WorldGuard, PlotSquared |  |
| WindChargeGuard | BedrockWindChargeFix-1.0.0.jar | 1.0.0 | plugin.yml |  | WorldGuard, Floodgate | /wcgreload |
| BlueSlimeCore | BlueSlimeCore-2.9.8.504.jar | 2.9.8.504 | paper-plugin.yml |  |  | /blueslimecore, /item-info, /item-to-base64, /item-to-nbt, /item-to-yml, /debug-event, /global-gamerule |
| BookEdit | BookEdit-1.1.jar | 1.1 | plugin.yml |  |  | /book |
| ChatEmojis | ChatEmojis-2.4.2.jar | 2.4.2 | plugin.yml |  |  | /emoji |
| Chunky | Chunky-Bukkit-1.5.3.jar | 1.5.3 | plugin.yml |  | dynmap, BlueMap, squaremap, WorldBorder | /chunky |
| CombatLogX | CombatLogX.jar | 11.6.0.0.1286 | plugin.yml | BlueSlimeCore | AngelChest, ASkyBlock, BentoBox, Citizens, CMI, CrackShot, CrashClaim, Essentials, FabledSkyBlock, FeatherBoard, FlagWar, GriefDefender, GriefPrevention, HuskHomes, HuskSync, HuskTowns, iDisguise, IridiumSkyblock, Kingdoms, Konquest, Lands, LibsDisguises, MarriageMaster, MCPets, MythicMobs, PlaceholderAPI, PlayerParticles, PreciousStones, PremiumVanish, ProtectionStones, ProtocolLib, RedProtect, Residence, Sentinel, SuperiorSkyblock2, SuperVanish, Towny, UltimateClaims, uSkyBlock, VanishNoPacket, WorldGuard | /combatlogx, /combat-timer, /togglepvp |
| CommandWhitelist | CommandWhitelist-Bukkit-2.12.0.jar | 2.12.0 | plugin.yml |  | ProtocolLib | /commandwhitelist |
| ConsoleSpamFixReborn | ConsoleSpamFixReborn-1.12.0.jar | 1.12.0 | plugin.yml |  |  | /csf |
| CoreProtect | CoreProtect-24.1.jar | 24.1 | plugin.yml |  | WorldEdit | /co, /core, /coreprotect |
| CrownCore | CrownCore-1.8.0.jar | 1.8.0 | plugin.yml |  | PlaceholderAPI, Vault, floodgate, WorldGuard, LuckPerms | /location, /crowncore, /crowngui |
| CrownStoreData | CrownStoreData-2.9.5.jar | 2.9.5 | plugin.yml | PlaceholderAPI, CrownCore | floodgate | /crownstoredata |
| DeluxeMenus | DeluxeMenus-1.14.1-Release.jar | 1.14.1-Release | plugin.yml |  | PlaceholderAPI, Vault, HeadDatabase, ItemsAdder, Nexo, Oraxen, ExecutableItems, ExecutableBlocks, Score, SimpleItemGenerator, MMOItems | /deluxemenus |
| DiaryKeeper | DiaryKeeper-1.4.11.jar | 1.4.11 | plugin.yml |  | Plan, Nexo, floodgate | /diary |
| DiscordSRV | DiscordSRV-Build-1.30.5.jar | 1.30.5 | plugin.yml |  | Chatty, FancyChat, Herochat, Legendchat, LunaChat, nChat, TownyChat, VentureChat, Essentials, PhantomAdmin, SuperVanish, Multiverse-Core, Vault, PlaceholderAPI, mcMMO, LuckPerms, dynmap, Skript | /discord |
| EnthusiaAdvancements | EnthusiaAdvancements-pilot.6-discord-test.3.jar | 1.0.0-pilot.6-discord-test.3 | plugin.yml | UltimateAdvancementAPI | DiscordSRV, InteractiveChat, InteractiveChatDiscordSrvAddon |  |
| EnthusiaBiomes | EnthusiaBiomes-1.0.1-26.2-test.1.jar | 1.0.1-26.2-test.1 | plugin.yml |  |  | /setbiome, /listbiomes, /reloadbiomes, /checkbiomes, /biomecycle |
| EnthusiaCommend | EnthusiaCommend-2.14.0-advancement-evidence-test.1.jar | 2.14.0-advancement-evidence-test.1 | plugin.yml | Vault | PlaceholderAPI, EnthusiaTeleport, ProtocolLib, WarzoneDuels, Plan | /rep |
| EnthusiaCurrency | EnthusiaCurrency-1.4.4-moderation-api.jar | 1.4.4 | plugin.yml | Vault | PlaceholderAPI, Plan | /balance, /deposit, /withdraw, /pay, /baltop, /currency |
| EnthusiaDisplay | EnthusiaDisplay-0.1.8-test.jar | 0.1.8-test | plugin.yml | UnlimitedNameTags, PlaceholderAPI | RoseChat | /display, /displayadmin |
| EnthusiaDonorNPCs | EnthusiaDonorNPCs-1.0.16.jar | 1.0.16 | plugin.yml | FancyNpcs, PlaceholderAPI |  | /EnthusiaDonorNPCs |
| EnthusiaDonors | EnthusiaDonors-1.1.0-test.15.jar | 1.1.0-test.15 | plugin.yml |  | PlaceholderAPI | /enthusiadonors, /donors |
| EnthusiaExpress | EnthusiaExpress-1.2.1.jar | 1.2.1 | plugin.yml |  | CombatLogX, Vault, EnthusiaCurrency, Nexo | /mail |
| EnthusiaFrontier | EnthusiaFrontier-0.1.1.jar | 0.1.1 | plugin.yml |  |  | /frontier |
| EnthusiaGiveaway | EnthusiaGiveaway-0.1.4.jar | 0.1.4 | paper-plugin.yml |  |  |  |
| EnthusiaLoreItems | EnthusiaLoreItems-1.0.2-tps-test.2.jar | 1.0.2-tps-test.2 | plugin.yml |  | floodgate | /loreitems, /loreitemsreview, /loredistribution |
| EnthusiaMapShields | EnthusiaMapShields-0.1.4.jar | 0.1.4 | plugin.yml |  | Nexo | /mapshield |
| EnthusiaMarket | EnthusiaMarket-1.0.52.jar | 1.0.52 | paper-plugin.yml |  |  | /enthusiamarket |
| EnthusiaPlaytime | EnthusiaPlaytime-3.7.2-discord-sync-test3.jar | 3.7.2 | plugin.yml |  | Plan, PlaceholderAPI, ProtocolLib, DiscordSRV, floodgate, Geyser-Spigot | /playtime, /roman, /firstjoin, /seen |
| EnthusiaServerAutoClicker | EnthusiaServerAutoClicker.jar | 1.0.0 | plugin.yml |  | CombatX | /autoclick |
| EnthusiaStaffAuthorityBridge | EnthusiaStaff-AuthorityBridge.jar | 0.1.0-SNAPSHOT | plugin.yml | LuckPerms | DiscordSRV |  |
| EnthusiaStaff | EnthusiaStaff-Paper.jar | 0.1.0-SNAPSHOT | plugin.yml |  | voicechat, ViaVersion, floodgate, Geyser-Spigot, CombatLogX, PolarLoader, ProtocolLib, DiscordSRV, LuckPerms, EnthusiaCurrency, EnthusiaMarket, EnthusiaCommend, EnthusiaTeleport, EnthusiaPlaytime, InventoryRollbackPlus, EnthusiaServerAutoClicker | /estaff, /history, /punish, /ban, /mute, /warn, /kick, /staffapi, /ipban, /removepunishment, /unban, /unmute, /removewarning, /unwarn, /report, /reports, /freeze, /unfreeze, /staff, /stafftools, /cheattester, /fakebase, /vanish, /staffchat, /staffwho, /client, /invsee, /endersee, /inspect, /case, /link, /unlink |
| EnthusiaTags | EnthusiaTags-2.2.2-unique-mail-test.1.jar | 2.2.2-unique-mail-test.1 | plugin.yml |  | WarzoneDuels, EnthusiaCommend, EnthusiaExpress, DiaryKeeper, EnthusiaAdvancements, RoseChat, PlaceholderAPI, LuckPerms, UnlimitedNametags, Vault, EnthusiaCurrency, EnthusiaPlaytime, EnthusiaLoreItems | /tags, /tag, /rewards, /cosmetics, /enthusiatags, /daily |
| EnthusiaTeleport | EnthusiaTeleport-1.2.9.jar | 1.2.9 | plugin.yml | CombatLogX | NewPlayerProtection | /tpa, /tpask, /tpahere, /tpaccept, /tpyes, /tpadeny, /tpno, /tpacancel, /tpignore, /sethome, /home, /homes, /delhome, /bed, /spawn, /tppos, /tpo, /invsee, /inventorysee, /endersee, /enderview, /rtp, /top, /back, /eteleport, /ahome |
| EnthusiaToiletFlush | EnthusiaToiletFlush-PaperCompanion-9.8.8.jar | 9.8.8 | plugin.yml |  | CheckHacks |  |
| EnthusiaVotes | EnthusiaVotes-v0.1.23.jar | 0.1.0 | paper-plugin.yml |  |  |  |
| FancyHolograms | FancyHolograms-2.12.0.jar | 2.12.0 | paper-plugin.yml |  |  |  |
| FancyNpcs | FancyNpcs-2.12.1.jar | 2.12.1 | paper-plugin.yml |  |  |  |
| FastAsyncWorldEdit | FastAsyncWorldEdit-Paper-2.15.4.jar | 2.15.4+d8666b3 | plugin.yml |  | Vault |  |
| FreedomChat | FreedomChat-Paper-1.7.9.jar | 1.7.9 | plugin.yml |  |  |  |
| GSit | GSit-3.7.0.jar | 3.7.0 | plugin.yml |  | GriefPrevention, PlaceholderAPI, PlotSquared, WorldGuard | /gsit, /glay, /glegsup, /gbellyflop, /gspin, /gcrawl, /gsitreload |
| HeadDB | HeadDB-7.0.0-rc.7.jar | 7.0.0-rc.7 | paper-plugin.yml |  |  |  |
| ImageFrame | ImageFrame-2026.1.5.0.jar | 2026.1.5.0 | plugin.yml |  | ViaVersion, PlaceholderAPI | /imageframe |
| InteractiveChat | InteractiveChat-2026.1.1.0 (1).jar | 2026.1.1.0 | plugin.yml | PlaceholderAPI, Vault | Essentials, EssentialsDiscord, EssentialsChat, DeluxeChat, CMI, SuperVanish, PremiumVanish, VentureChat, DiscordSRV, dynmap, eco, ViaVersion, ProtocolSupport, LuckPerms, MysqlPlayerDataBridge, ChatControlRed, floodgate, ExcellentEnchants, ProtocolLib, CraftEngine | /interactivechat |
| InteractiveChatDiscordSrvAddon | InteractiveChatDiscordSrvAddon-2026.1.1.0 (1).jar | 2026.1.1.0 | plugin.yml | InteractiveChat, DiscordSRV | ItemsAdder, ImageFrame, CraftEngine | /interactivechatdiscordsrv |
| InventoryRollbackPlus | InventoryRollbackPlus-1.8.5.jar | 1.8.5 | plugin.yml |  |  | /inventoryrollbackplus |
| InvisibleItemFramesLite | InvisibleItemFramesLite-3.2.2.jar | 3.2.2 | plugin.yml |  |  |  |
| ItemSignature | ItemSignature-1.1.0.jar | 1.1.0 | plugin.yml |  | DiaryKeeper, EnthusiaLoreItems, Nexo | /sign, /track, /itemsignature |
| LPX | LPX (1).jar | 3.9.0 | plugin.yml |  | ProtocolLib, ProtocolSupport, ViaVersion, ViaBackwards, ViaRewind, Geyser-Spigot | /lpx |
| LuckPerms | LuckPerms-Bukkit-5.5.85.jar | 5.5.85 | plugin.yml |  | LilyPad-Connect, ViaVersion | /luckperms |
| LumaGuilds | LumaGuilds-3.0.20.jar | 3.0.20 | plugin.yml | RoseChat | Vault, PlaceholderAPI, AxKoth, LiteBans, EnthusiaPlaytime, Nexo, packetevents, DiscordSRV | /guild, /claim, /claimlist, /claimmenu, /claimoverride, /pc, /gc, /gac, /gmc, /ga, /lumaguilds, /bedrockcachestats, /vaultrollback, /bankcredit, /removevault |
| LumaTrivia | LumaTrivia-1.0.7.jar | 1.1.0 | paper-plugin.yml |  |  |  |
| NotBounties | NotBounties-1.22.37.jar | 1.22.37 | plugin.yml |  | PlaceholderAPI, HeadDataBase, Vault, LiteBans, SkinsRestorer, BetterTeams, Towny, Geyser-Spigot, floodgate, Kingdoms, Lands, WorldGuard, Factions, Essentials, MythicLib, Duels, SimpleClans, packetevents, Skript, Konquest, EconomyShopGUI, EconomyShopGUI-Premium, CMI, SimpleClaimSystem | /notbounties, /notbountiesadmin |
| NoteBlockAPI | NoteBlockAPI-1.7.0.jar | 1.7.0 | plugin.yml |  |  |  |
| OreAnnouncer | OreAnnouncer-2.8.5.jar | 2.8.5 | plugin.yml |  | DiscordSRV, ItemMods, LastLoginAPI, MMOItems, PlaceholderAPI |  |
| PAPIProxyBridge | PAPIProxyBridge-Bukkit-1.8.4-72367f6.jar | 1.8.4-72367f6 | plugin.yml | PlaceholderAPI |  |  |
| PearlGlitchBlocker | PearlGlitchBlocker-1.0.0-SNAPSHOT.jar | 1.0.0-SNAPSHOT | plugin.yml |  |  | /pearlglitchblocker |
| PieCloak | PieCloak-1.21.11-visibility-test.3-3084a56.jar | 0.7.0-SNAPSHOT-Paper-0.10.0-SNAPSHOT+build-2026-09-27T07-32-54.956865900Z+git-3084a56b | plugin.yml | packetevents | FancyNpcs, FancyHolograms, WorldGuard |  |
| Pl-Hide-Free | Pl-Hide-Free-2.0.8.jar | 2.0.8 | plugin.yml |  |  | /plhide |
| PlaceholderAPI | PlaceholderAPI-2.12.3.jar | 2.12.3 | plugin.yml |  |  | /placeholderapi |
| PolarLoader | PolarLoader.jar | 1.2.0 | plugin.yml |  | ProtocolLib, ProtocolSupport, ViaVersion, ViaBackwards, ViaRewind, Geyser-Spigot, floodgate |  |
| PolarLogs | PolarLogs-2.7.1.jar | 2.7.1 | plugin.yml | PolarLoader |  |  |
| PoseProbe | PoseProbe-0.1.0-local-diagnostic.jar | 0.1.0-local-diagnostic | plugin.yml | ProtocolLib |  | /poseprobe |
| ProtocolLib | ProtocolLib-26.2-dev.jar | 5.5.0-SNAPSHOT-583353e | paper-plugin.yml |  |  |  |
| RoseChat | RoseChat-RC-4.jar | RC-4 | plugin.yml |  | Vault, PlaceholderAPI, DiscordSRV, ProtocolLib, Essentials, LuckPerms, Towny, mcMMO, WorldGuard, WorldEdit, SimpleClans, Factions, Kingdoms, BentoBox, SuperiorSkyblock2, IridiumSkyblock, FabledSkyblock, MarriageMaster, InteractiveChat, HuskTowns |  |
| SkBee | SkBee-3.26.0.jar | 3.26.0 | paper-plugin.yml |  |  |  |
| Skript | Skript-2.16.2.jar | 2.16.2 | plugin.yml |  | SQLibrary, Vault, WorldGuard, Residence, PreciousStones, GriefPrevention | /skript |
| SleepMultiplier | SleepMultiplier-1.2.0.jar | 1.2.0 | plugin.yml |  |  | /sleepmultiplier |
| StartupGuardian | StartupGuardian-1.1.1.jar | 1.1.1 | plugin.yml |  |  | /startupguardian |
| TAB | TAB v6.2.0.jar | 6.2.0 | plugin.yml |  | PlaceholderAPI, LuckPerms, LibsDisguises, ViaVersion, ViaRewind, floodgate, Vault | /tab |
| TotemGuard | TotemGuard-2.1.4.jar | 2.1.4 | plugin.yml | packetevents |  |  |
| UltimateAdvancementAPI | UltimateAdvancementAPI-Plugin-2.8.1-loading-guard-test.1.jar | 2.8.1 | plugin.yml |  |  |  |
| UnlimitedNameTags | UnlimitedNametags-2.0.2-rendering-fix.2.jar | 2.0.2-rendering-fix.2 | plugin.yml | packetevents | PlaceholderAPI, ProtocolLib, ProtocolSupport, ViaVersion, ViaBackwards, ViaRewind, Oraxen, Nexo, HMCCosmetics |  |
| Vault | Vault.jar | 1.7.3-b131 | plugin.yml |  |  | /vault-info, /vault-convert |
| ViaBackwards | ViaBackwards-5.12.0.jar | 5.12.0 | plugin.yml | ViaVersion |  |  |
| ViaVersion | ViaVersion-5.12.0.jar | 5.12.0 | plugin.yml |  |  | /viaversion |
| VillagerLobotimizer | VillagerLobotimizer-1.16.0.jar | 1.16.0 | paper-plugin.yml |  |  |  |
| VoiceChatPlaceholders | VoiceChatPlaceholders.jar | 1.1 | plugin.yml | voicechat, PlaceholderAPI |  | /vcp |
| VoidGen | VoidGen-2.3.8 (1).jar | 2.3.8 | plugin.yml |  |  |  |
| WarzoneDuels | WarzoneDuels-1.0.4.jar | 1.0.4 | plugin.yml |  | Vault, EnthusiaTeleport, EnthusiaTags, NotBounties, CombatLogX, Plan | /duel, /surrender, /vault, /stats |
| WorldGuardExtraFlags | WorldGuardExtraFlags.jar | 4.2.4-SNAPSHOT | plugin.yml | WorldGuard | ProtocolLib |  |
| WorldGuardInvisibleRegions | WorldGuardInvisibleRegions-1.0.1.jar | 1.0.1 | plugin.yml | WorldGuard |  |  |
| XMMForceFairPlay | XMMForceFairPlay-1.1.0.jar | 1.1.0 | plugin.yml | packetevents |  |  |
| aNewbie | aNewbie-1.9.3.jar | 1.9.3 | plugin.yml |  | PlaceholderAPI, WorldGuard, Vault |  |
| Apollo-Bukkit | apollo-bukkit-1.2.9.jar | 1.2.9 | plugin.yml |  |  | /apollo, /lunarclient |
| EnthusiaKOTH | enthusiakoth-0.1.0-SNAPSHOT.jar | 0.1.0-SNAPSHOT | plugin.yml |  | Vault, PlaceholderAPI, LumaGuilds | /ekoth |
| fairy-lib-plugin | fairy-lib-plugin-0.8.7b2.jar | 0.8.7b2-SNAPSHOT | plugin.yml |  |  |  |
| floodgate | floodgate-spigot.jar | 2.2.5-SNAPSHOT (b141-81b65cc) | plugin.yml |  |  |  |
| NBTAPI | item-nbt-api-plugin-2.16.1.jar | 2.16.1 | plugin.yml |  |  |  |
| JukeBox | jukebox-1.20.15.jar | 1.20.15 | plugin.yml | NoteBlockAPI | PlaceholderAPI | /music, /adminmusic |
| MaceGuard | maceguard-6.1.8-water-riptide-test.8.jar | 6.1.8-water-riptide-test.8 | plugin.yml | WorldGuard | PlaceholderAPI, CombatLogX | /maceguard, /maceguardpearltrace, /warzone, /stasis |
| Multiverse-Core | multiverse-core-5.8.1.jar | 5.8.1 | plugin.yml |  | Vault, PlaceholderAPI |  |
| Nexo | nexo-1.28.jar | 1.28 | paper-plugin.yml |  |  |  |
| Votifier | nuvotifier(1).jar | 2.7.3 | plugin.yml |  |  | /nvreload, /testvote |
| packetevents | packetevents-spigot-2.14.0.jar | 2.14.0 | plugin.yml |  | ProtocolLib, ProtocolSupport, ViaVersion, ViaBackwards, ViaRewind, Geyser-Spigot |  |
| PaperMCP | papermcp-plugin-1.0.0-snapshot(1).jar | 1.0.0-SNAPSHOT | plugin.yml |  |  | /papermcp |
| Rtag | rtag-1.5.18.jar | 1.5.18 | plugin.yml |  |  |  |
| skript-placeholders | skript-placeholders-1.7.1.jar | 1.7.1 | plugin.yml |  | Skript, PlaceholderAPI, MVdWPlaceholderAPI |  |
| Tebex | tebex-bukkit-2.4.0-974a9d5.jar | 2.4.0 | plugin.yml |  | BuycraftX | /tebex |
| voicechat | voicechat-bukkit-2.6.24.jar | 2.6.24 | plugin.yml |  | PlaceholderAPI, ViaVersion | /voicechat |
| WorldGuard | worldguard-bukkit-7.0.19.jar | 7.0.19+2400-f395a16 | plugin.yml | WorldEdit |  |  |
