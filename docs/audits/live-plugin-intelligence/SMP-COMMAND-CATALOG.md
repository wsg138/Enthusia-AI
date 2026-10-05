# SMP declared command catalog

Evidence: same fresh 2026-10-05 SMP deployment inventory.

Visibility warning: this is a STAFF/internal catalog. A command existing in plugin metadata does not mean a normal player should be told about it. Permission defaults and runtime policy still govern exposure.

| Plugin | Command | Declared permission | Usage / description |
|---|---|---|---|
| AutomaticBroadcast | /automaticbroadcast |  | AutomaticBroadcast commands. |
| WindChargeGuard | /wcgreload | windchargeguard.reload | Reload WindChargeGuard configuration |
| BlueSlimeCore | /blueslimecore |  | /<command> help |
| BlueSlimeCore | /item-info |  | /<command> |
| BlueSlimeCore | /item-to-base64 |  | /<command> |
| BlueSlimeCore | /item-to-nbt |  | /<command> [pretty] |
| BlueSlimeCore | /item-to-yml |  | /<command> |
| BlueSlimeCore | /debug-event |  | /<command> <priority> <full.package.with.ClassNameEvent> |
| BlueSlimeCore | /global-gamerule |  | /<command> <gamerule> <value> |
| BookEdit | /book |  | /book anonymous - Makes the book author anonymous; /book tattered - Makes to book tattered; /book help - Shows help |
| ChatEmojis | /emoji |  | <command> |
| Chunky | /chunky | chunky.command | /chunky |
| CombatLogX | /combatlogx | combatlogx.command.combatlogx | /<command> help |
| CombatLogX | /combat-timer | combatlogx.command.combat-timer | /<command> [player] |
| CombatLogX | /togglepvp | combatlogx.command.togglepvp | /<command> check /<command> on/off /<command> admin on/off <player> |
| CommandWhitelist | /commandwhitelist |  | /commandwhitelist [args] |
| ConsoleSpamFixReborn | /csf |  | The main command. |
| CoreProtect | /co | coreprotect.co | /<command> <params> |
| CoreProtect | /core | coreprotect.core | /<command> <params> |
| CoreProtect | /coreprotect | coreprotect.coreprotect | /<command> <params> |
| CrownCore | /location | core.command.location | Command to manage locations |
| CrownCore | /crowncore | core.command.core | Command for core |
| CrownCore | /crowngui | core.command.gui | Command for managing crown guis |
| CrownStoreData | /crownstoredata |  |  |
| DeluxeMenus | /deluxemenus |  | DeluxeMenus main commands |
| DiaryKeeper | /diary | diary.admin | /diary <reload/issue/status/find/restore/purge/scan/repair> |
| DiscordSRV | /discord | discordsrv.discord | /discord - Show the invite link of the Discord server /discord help/? - Show command list /discord link - Link Minecraft account with Discord account /discord unlink - Remove link between Minecraft and Discord account /discord linked - Show information about linking status /discord broadcast - Broadcast a message to Discord /discord debug - Send debug information to Gist /discord reload - Reload the plugin /discord resync - Resynchronizes all groups & roles /discord language - Changes the language of DiscordSRV to whatever is specified /discord debugger - A toggleable timings-like command to dump debug information to bin.scarsz.me  |
| EnthusiaBiomes | /setbiome | custombiomes.setbiome | /setbiome <biome_id> [radius] |
| EnthusiaBiomes | /listbiomes | custombiomes.list | /listbiomes |
| EnthusiaBiomes | /reloadbiomes | custombiomes.reload | /reloadbiomes |
| EnthusiaBiomes | /checkbiomes | custombiomes.check | /checkbiomes |
| EnthusiaBiomes | /biomecycle | custombiomes.cycle | /biomecycle [start/stop/skip/status] |
| EnthusiaCommend | /rep | enthusiacommend.rep.view | /rep |
| EnthusiaCurrency | /balance |  | /balance [player] |
| EnthusiaCurrency | /deposit |  | /deposit [amount/all] |
| EnthusiaCurrency | /withdraw |  | /withdraw <amount> |
| EnthusiaCurrency | /pay |  | /pay <player> <amount> |
| EnthusiaCurrency | /baltop |  | /baltop [page] |
| EnthusiaCurrency | /currency |  | /currency reload |
| EnthusiaDisplay | /display |  | /display [nametag/tab/chat] [preset <name>/toggle <field>/reset] |
| EnthusiaDisplay | /displayadmin | enthusiadisplay.admin | /displayadmin inspect <subject> / stats / recover / export <new-folder> |
| EnthusiaDonorNPCs | /EnthusiaDonorNPCs |  | /EnthusiaDonorNPCs <reload/update/status> |
| EnthusiaDonors | /enthusiadonors | enthusiadonors.test | /enthusiadonors test menu |
| EnthusiaDonors | /donors | enthusiadonors.view | /donors [monthly/alltime/me/profile/directory/glorious] |
| EnthusiaExpress | /mail | enthusiaexpress.use | /mail <send/letter/announce/inbox/sent/mapart/block/unblock/blocked> |
| EnthusiaFrontier | /frontier | enthusiafrontier.admin | /frontier status / /frontier evidence |
| EnthusiaLoreItems | /loreitems |  | /loreitems create/adopt/give/reload/browse/anomalies/audit/recovery/remove/purge/delete/operations/targets/destructive-metrics/pause-operation/resume-operation/resolve-removal ... |
| EnthusiaLoreItems | /loreitemsreview | enthusia.loreitems.admin.recovery.review | /loreitemsreview <mutation-uuid> <mutation-type> <retry/cancel> <evidence> |
| EnthusiaLoreItems | /loredistribution |  | /loredistribution reload/inspect/preview/confirm/campaigns/status/recipients/pause/resume/cancel/reconcile ... |
| EnthusiaMapShields | /mapshield |  | /mapshield |
| EnthusiaMarket | /enthusiamarket |  | /enthusiamarket <subcommand> |
| EnthusiaPlaytime | /playtime |  | /playtime |
| EnthusiaPlaytime | /roman |  | /roman |
| EnthusiaPlaytime | /firstjoin |  | /firstjoin [player] |
| EnthusiaPlaytime | /seen |  | /seen [player] |
| EnthusiaServerAutoClicker | /autoclick |  | /autoclick [ticks/off/status/check <player>/reload] |
| EnthusiaStaff | /estaff |  | /estaff <status/verify [full]/reload/sanction> |
| EnthusiaStaff | /history | enthusiastaff.history.view | /history <player/uuid> [page] |
| EnthusiaStaff | /punish | enthusiastaff.punish | /punish <player> [reason-id] or /punish resume <player> |
| EnthusiaStaff | /ban | enthusiastaff.punish | /ban <player> [reason-id] |
| EnthusiaStaff | /mute | enthusiastaff.punish | /mute <player> [reason-id] |
| EnthusiaStaff | /warn | enthusiastaff.punish | /warn <player> [reason-id] |
| EnthusiaStaff | /kick | enthusiastaff.punish | /kick <player> [reason-id] |
| EnthusiaStaff | /staffapi |  | /staffapi punish <player> <ban/kick/mute/warn> [reason...] [--checks=<detail>] |
| EnthusiaStaff | /ipban | enthusiastaff.punish.ip | /ipban <player> [reason-id] |
| EnthusiaStaff | /removepunishment | enthusiastaff.remove | /removepunishment <player/case> <action> [expiration] <reason> [CONFIRM] |
| EnthusiaStaff | /unban | enthusiastaff.remove | /unban <player/case> <reason> [CONFIRM] |
| EnthusiaStaff | /unmute | enthusiastaff.remove | /unmute <player/case> <reason> [CONFIRM] |
| EnthusiaStaff | /removewarning | enthusiastaff.remove | /removewarning <player/case> <reason> [CONFIRM] |
| EnthusiaStaff | /unwarn | enthusiastaff.remove | /unwarn <player/case> <reason> [CONFIRM] |
| EnthusiaStaff | /report |  | /report <player/uuid> <reason-id> <description> |
| EnthusiaStaff | /reports | enthusiastaff.reports.manage | /reports |
| EnthusiaStaff | /freeze | enthusiastaff.freeze | /freeze <player> <reason> / /freeze keep <player> <reason> CONFIRM / /freeze status <player/uuid> / /freeze list |
| EnthusiaStaff | /unfreeze | enthusiastaff.freeze | /unfreeze <player> <reason> CONFIRM |
| EnthusiaStaff | /staff | enthusiastaff.staffmode | /staff |
| EnthusiaStaff | /stafftools | enthusiastaff.stafftools.menu | /stafftools / /stafftools random / /stafftools spectate <player> |
| EnthusiaStaff | /cheattester | enthusiastaff.cheattester | /cheattester <select/run/cancel/status/config/base> |
| EnthusiaStaff | /fakebase | enthusiastaff.cheattester.fake-base | /fakebase <create/extend/clear/teleport/status> [player] |
| EnthusiaStaff | /vanish | enthusiastaff.vanish | /vanish / /vanish tab <show/hide> |
| EnthusiaStaff | /staffchat |  | /staffchat |
| EnthusiaStaff | /staffwho | enthusiastaff.staffwho | /staffwho |
| EnthusiaStaff | /client | enthusiastaff.client | /client <player/uuid> [save CONFIRM] |
| EnthusiaStaff | /invsee | enthusiastaff.inventory.view | /invsee <player/uuid> |
| EnthusiaStaff | /endersee | enthusiastaff.inventory.view | /endersee <player/uuid> |
| EnthusiaStaff | /inspect | enthusiastaff.inspect | /inspect <player> |
| EnthusiaStaff | /case |  | /case [view] <case-id> / /case restoreitems <case-id> / /case recoveritems <case-id> |
| EnthusiaStaff | /link |  | /link [code] |
| EnthusiaStaff | /unlink |  | /unlink CONFIRM |
| EnthusiaTags | /tags | enthusia.tags.use | /tags |
| EnthusiaTags | /tag | enthusia.tags.admin | /tag <give/revoke/set/clear/list/create/edit/offset/sibling/reload> |
| EnthusiaTags | /rewards | enthusia.tags.rewards | /rewards |
| EnthusiaTags | /cosmetics | enthusia.cosmetics.use | /cosmetics |
| EnthusiaTags | /enthusiatags | enthusia.tags.admin | /enthusiatags <reload/performance/rewards/daily> |
| EnthusiaTags | /daily | enthusia.tags.daily | /daily |
| EnthusiaTeleport | /tpa | enthusia.teleport.tpa | /tpa <player> |
| EnthusiaTeleport | /tpask | enthusia.teleport.tpa | /tpask <player> |
| EnthusiaTeleport | /tpahere | enthusia.teleport.tpahere | /tpahere <player> |
| EnthusiaTeleport | /tpaccept | enthusia.teleport.tpaccept | /tpaccept [player] |
| EnthusiaTeleport | /tpyes | enthusia.teleport.tpaccept | /tpyes [player] |
| EnthusiaTeleport | /tpadeny | enthusia.teleport.tpadeny | /tpadeny [player] |
| EnthusiaTeleport | /tpno | enthusia.teleport.tpadeny | /tpno [player] |
| EnthusiaTeleport | /tpacancel | enthusia.teleport.tpacancel | /tpacancel |
| EnthusiaTeleport | /tpignore | enthusia.teleport.tpignore | /tpignore <player/list> |
| EnthusiaTeleport | /sethome | enthusia.teleport.sethome | /sethome <name> |
| EnthusiaTeleport | /home | enthusia.teleport.home | /home [name/name force] |
| EnthusiaTeleport | /homes | enthusia.teleport.home | /homes [player] |
| EnthusiaTeleport | /delhome | enthusia.teleport.delhome | /delhome <name> |
| EnthusiaTeleport | /bed | enthusia.teleport.bed | /bed [name/list/manage/delete <name>/rename <old> <new>] |
| EnthusiaTeleport | /spawn | enthusia.teleport.spawn | /spawn |
| EnthusiaTeleport | /tppos | enthusia.teleport.tppos | /tppos <x> <y> <z> [world] |
| EnthusiaTeleport | /tpo | enthusia.teleport.tpo | /tpo <player> [force] |
| EnthusiaTeleport | /invsee | enthusia.teleport.invsee | /invsee <player> |
| EnthusiaTeleport | /inventorysee | enthusia.teleport.invsee | /inventorysee <player> |
| EnthusiaTeleport | /endersee | enthusia.teleport.endersee | /endersee <player> |
| EnthusiaTeleport | /enderview | enthusia.teleport.endersee | /enderview <player> |
| EnthusiaTeleport | /rtp | enthusia.teleport.rtp | /rtp |
| EnthusiaTeleport | /top | enthusia.teleport.top | /top |
| EnthusiaTeleport | /back | enthusia.teleport.back | /back |
| EnthusiaTeleport | /eteleport | enthusia.teleport.admin | /eteleport reload/performance/homes clear/homes del/homes tp |
| EnthusiaTeleport | /ahome | enthusia.teleport.admin.homes.view | /ahome <player> |
| GSit | /gsit |  | /<command> [toggle/playertoggle] |
| GSit | /glay | GSit.Lay | /<command> |
| GSit | /glegsup | GSit.LegsUp | /<command> |
| GSit | /gbellyflop | GSit.Bellyflop | /<command> |
| GSit | /gspin | GSit.Spin | /<command> |
| GSit | /gcrawl |  | /<command> [toggle] |
| GSit | /gsitreload | GSit.Reload | /<command> |
| ImageFrame | /imageframe |  | Plugin main command |
| InteractiveChat | /interactivechat |  | /<command> |
| InteractiveChatDiscordSrvAddon | /interactivechatdiscordsrv |  | /<command> |
| InventoryRollbackPlus | /inventoryrollbackplus |  | /irp <subcommand> |
| ItemSignature | /sign |  | /sign [--color <red or #RRGGBB>] [message] / confirm / cancel |
| ItemSignature | /track |  | /track <player_kills/mob_kills/blocks_broken> |
| ItemSignature | /itemsignature |  | /itemsignature [reload] |
| LPX | /lpx |  | Main command |
| LuckPerms | /luckperms |  | Manage permissions |
| LumaGuilds | /guild |  | /guild <subcommand> [args] |
| LumaGuilds | /claim |  | /claim <subcommand> [args] |
| LumaGuilds | /claimlist |  | /claimlist |
| LumaGuilds | /claimmenu |  | /claimmenu |
| LumaGuilds | /claimoverride |  | /claimoverride <subcommand> [args] |
| LumaGuilds | /pc |  | /pc <subcommand> [args] |
| LumaGuilds | /gc |  | /gc [message] |
| LumaGuilds | /gac |  | /gac [message] |
| LumaGuilds | /gmc |  | /gmc [message] |
| LumaGuilds | /ga |  | /ga [color] <message> |
| LumaGuilds | /lumaguilds | lumaguilds.admin | /lumaguilds <subcommand> [args] |
| LumaGuilds | /bedrockcachestats | lumaguilds.bedrock.cache.stats | /bedrockcachestats [stats/clear/help] |
| LumaGuilds | /vaultrollback | lumaguilds.admin.vault.rollback | /vaultrollback <list/restore> <guild> [backupId] |
| LumaGuilds | /bankcredit | lumaguilds.admin.bank.credit | /bankcredit <player> <amount> |
| LumaGuilds | /removevault | lumaguilds.admin.vault.remove | /removevault <guild> [dropItems] |
| NotBounties | /notbounties | notbounties.player | Use all of the bounty commands. |
| NotBounties | /notbountiesadmin | notbounties.admin | Run bounty commands for other people. |
| PearlGlitchBlocker | /pearlglitchblocker | pearlglitchblocker.admin | /<command> reload/region |
| Pl-Hide-Free | /plhide |  | /plhide reload |
| PlaceholderAPI | /placeholderapi |  | PlaceholderAPI Command |
| PoseProbe | /poseprobe |  | Console-only 30-second pose observer |
| Skript | /skript | skript.admin | /skript help |
| SleepMultiplier | /sleepmultiplier | sleepmultiplier.reload | /<command> reload |
| StartupGuardian | /startupguardian | startupguardian.admin | /startupguardian <status/check/reload/reset/testdiscord/help> |
| TAB | /tab |  | Plugin's main command |
| Vault | /vault-info | vault.admin | /<command> - Displays Vault information  |
| Vault | /vault-convert | vault.admin | /<command> [economy1] [economy2]  |
| ViaVersion | /viaversion | viaversion.command | Shows ViaVersion Version and more. |
| VoiceChatPlaceholders | /vcp | voicechatplaceholders.reload | /vcp reload |
| WarzoneDuels | /duel |  | /duel <player/party/accept/deny/review/watch/leave/draw/vault/stats/info/settings/mode> |
| WarzoneDuels | /surrender |  | /surrender |
| WarzoneDuels | /vault |  | /vault |
| WarzoneDuels | /stats |  | /stats [player] |
| Apollo-Bukkit | /apollo | apollo.command | /apollo <reload/update> |
| Apollo-Bukkit | /lunarclient | apollo.lunarclient | /lunarclient <player> |
| EnthusiaKOTH | /ekoth | enthusiakoth.command | /ekoth |
| JukeBox | /music | music.command | Main command for musics |
| JukeBox | /adminmusic | music.command.admin | Admin command for musics |
| MaceGuard | /maceguard |  | /<command> here/status/capture/validate/plan/arm/disarm/schedule/reset/recover/temporary/reload |
| MaceGuard | /maceguardpearltrace | warzonerotator.command.debug | /<command> <on/off/show> <player> |
| MaceGuard | /warzone |  | /<command> [info/modifiers/modifier/kit/kits/items/next/schedule/menu/help/random/override/reload/validate/debug] |
| MaceGuard | /stasis |  | /<command> |
| Votifier | /nvreload | nuvotifier.reload | /nvreload |
| Votifier | /testvote | nuvotifier.testvote | /testvote [username] [serviceName=?] [username=?] [address=?] [localTimestamp=?] [timestamp=?] |
| PaperMCP | /papermcp | papermcp.admin | /papermcp [status/clients/reload/help] |
| Tebex | /tebex |  | The main command |
| voicechat | /voicechat |  | Invalid command syntax |
