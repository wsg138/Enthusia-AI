# SMP current feature state

Evidence baseline: `wsg138/Enthusia-Server@b5bd154c4d28a3e935239778ca8999b8ca74e83a`, captured 2026-10-05 06:37 UTC.

Purpose: a compact current-truth layer for support/retrieval. These facts come from the deployed JAR inventory, sanitized live configuration, and matching startup/runtime log. They are **not model-weight facts** and must be refreshed when deployment changes.

## Truth rules

- Runtime/deployed evidence outranks repository defaults.
- A feature existing in code or commands does not mean it is enabled.
- A config flag saying an integration is enabled does not prove the target plugin is installed or the hook succeeded.
- Staff/internal details remain staff-visible even when present in this file.
- Player-facing answers should explain only the parts useful to the player.

## Economy — EnthusiaCurrency

Status: **CURRENT / ENABLED**

Player-facing facts:

- Currency is called **Dollars** and uses `$`.
- Physical currency is **Raw Gold**.
- 1 Raw Gold = 1 Dollar.
- 1 Raw Gold Block = 9 Dollars.
- New accounts start at $0.
- Decimal balances are disabled.
- `/baltop` uses a GUI and refreshes about every 15 seconds.
- Balance/item leaderboards are enabled.

Internal/current caveats:

- Currency config has Plan integration enabled, but Plan is not installed in the fresh SMP plugin inventory. Do not claim Plan-backed Currency analytics are active from the config flag alone.
- PlaceholderAPI and internal analytics are enabled.

## Mail — EnthusiaExpress

Status: **CURRENT / ENABLED**

Player-facing facts:

- Packages, letters, announcements, inbox/sent-mail flows are active.
- Letters are enabled with a 10-second send cooldown.
- Announcements are enabled with a 10-second cooldown.
- Players get join notifications for pending packages, unread letters, and announcements.
- Packages cost 1 unit of currency per packed item under the current configuration.
- Payments use the automatic EnthusiaCurrency/Vault path when available.
- Mail is blocked during CombatLogX combat protection.
- Players cannot use normal letter/package sending as a substitute for direct trade with a currently online target where the relevant flow rejects online recipients.
- Packages must be packed in a Shulker Box or Bundle.
- The one-outstanding-package and one-outstanding-letter limits are currently disabled.

Internal/current caveats:

- Nexo GUI assets are disabled.
- Production JAR is an exact CI artifact from `FainNeito/Enthusia-Express@d5c519455ce7429e0e939762ca583d4fb774e543`.
- Express runtime successfully bound EnthusiaCurrency 1.4.4 moderation API v1 for mail movement leases.

## Reputation — EnthusiaCommend

Status: **CURRENT / ENABLED**

Player-facing facts:

- Enthusia has a player reputation/feedback system.
- A player needs at least **12 active playtime hours** before the configured reputation flow permits the relevant participation.
- Current positive categories include:
  - Was Kind — friendly/helpful/supportive behavior.
  - Gave Items — gave items or money fairly.
  - Trustworthy — kept promises and acted reliably.
  - Good Stall — ran a fair and reliable market stall.
- Current negative categories include:
  - Scammed.
  - Spawn Killed.
  - Griefed.
  - Trapped.
- Reputation edits/removals currently use 24-hour cooldown rules.
- IP protection is enabled to reduce same-household/address abuse.
- Reputation can affect teleport/effect behavior at configured thresholds.

Answer-style note:

- For a player unfamiliar with reputation, explain the system briefly before explaining a category.
- For a player already familiar with /rep or the system, answer directly without repeating the introduction.

Internal/current caveats:

- Commend config has Plan integration enabled, but Plan is absent from current SMP runtime; do not claim that integration is active.
- Runtime confirms Commend linked to EnthusiaTeleport.

## Playtime and progression — EnthusiaPlaytime

Status: **CURRENT / ENABLED**

Player-facing facts:

- Playtime rewards are enabled.
- Current examples:
  - 1 total hour: Noob Vibes tag.
  - 2 total hours: $500 reward.
  - 4 active hours: builder pack.
  - 8 active hours: market stall permission.
  - 12 active hours: reputation-add permission.
  - 24 total hours: $2,500 reward.
- Playtime numeral Discord roles are enabled in highest-only mode.
- Public playtime leaderboards are enabled.

Caution:

- Reward configuration is mutable. Before answering about an exact reward/threshold, prefer this current live source over old documentation or model memory.

## Teleportation — EnthusiaTeleport

Status: **CURRENT / ENABLED**

Player-facing facts:

- Teleports currently use a 5-second warmup.
- There is no general teleport cooldown in the current config.
- Teleport requests expire after 60 seconds.
- Combat blocking is enabled for 30 seconds after dealing/taking damage.
- Default home limit is 1; permission/rank overrides can raise it.
- New players are sent to configured spawn and receive a starter kit.
- `/rtp` is enabled in the overworld.
- Default RTP allowance is 1 use unless a permission/rank override grants more.
- RTP searching is queued/bounded for server performance.
- The `surfevents` world is currently blocked as a teleport target for normal teleport flows.
- Back history keeps up to 10 locations.

## Guilds — LumaGuilds

Status: **PARTIALLY ENABLED**

Player-facing/current facts:

- Guild system is active.
- Maximum guild size is currently 20 members.
- Guild creation costs 1,000 under current config.
- Guild homes are active.
- Activating a guild home currently costs **100**.
- The configured home cost scale is 1.0, so additional home ordinal does not increase that 100 base cost.
- Guild-home teleport warmup is 3 seconds; cooldown is 5 seconds.
- Guild banks/vaults are active.
- Parties are enabled.
- Guild, guild-ally, and party chat are enabled.
- Guild chat is actively wired to RoseChat.
- Discord guild-role integration is configured/enabled.
- Chapter 2 is active in current configuration from 2026-10-03 through 2027-02-01.
- Seasonal ELO is enabled.

Important disabled feature:

- **Guild claims are currently disabled.**
- Startup explicitly reports that all claim features are unavailable.
- Do not answer a player as if guild claims can currently be created simply because claim commands/classes exist.

Runtime integrations:

- RoseChat integration is active.
- Apollo/Lunar Client integration is active.
- DiscordSRV account-link/profile listeners are registered.
- AxKoth integration is unavailable because AxKoth is not installed.
- Web API is configured/enabled on port 2052; external exposure has not yet been verified by this audit.

## Chat — RoseChat / DiscordSRV / InteractiveChat

Status: **CURRENT, WITH ONE DEGRADED PRESENCE INTEGRATION**

Current channels:

- Global.
- Staff.
- Guild.
- Guild ally.
- Guild officer/modchat.

Runtime-confirmed integrations:

- InteractiveChat is hooked into DiscordSRV.
- InteractiveChat is hooked into ViaVersion, LuckPerms, and floodgate.
- InteractiveChatDiscordSrvAddon is hooked into DiscordSRV and ImageFrame.
- LumaGuilds guild channels are registered in RoseChat.
- LumaTrivia detects RoseChat and uses the global channel-scoped chat platform.

Known degradation:

- EnthusiaTags cannot bind RoseChat `PresenceMessageEvent` because the currently deployed RoseChat artifact is the wrong/older RC-4 build.
- Tags therefore retains RoseChat audience/default behavior instead of its intended presence customization.
- Tracked in issue #36.

## AI chat moderation — RoseChat moderation path

Status: **ENFORCEMENT ACTIVE / AUTOMATIC PUNISHMENTS DISABLED**

Current live configuration:

- AI moderation enabled.
- Shadow mode is false, so qualifying messages can actually be blocked/deleted.
- Model is `omni-moderation-latest`.
- Maximum chat hold is 200 ms.
- Request timeout is 2 seconds.
- Context window uses up to 6 prior messages and 3 after/follow-up messages within its configured bounds.
- Automatic strike/mute punishments are disabled.

Important authority rule:

- Do not tell players that this path automatically mutes them based on the current configuration.
- It can enforce chat message visibility, while punishment authority remains separate.

## Staff transition authority — EnthusiaStaffAuthorityBridge

Status: **CURRENT / HEALTHY WITH ONE CONFLICTED LEGACY IDENTITY**

Runtime mode:

- Authority endpoint is private-only.
- Commands exposed by the bridge: 0.
- Moderation mutations performed by the bridge: 0.
- Transition collector migrations enabled.
- DiscordSRV source is read-only.
- LiteBans is untouched.
- Collector runs every 60 seconds.

Observed behavior:

- Most passes report one migration conflict.
- The migration code defines a conflict as a legacy DiscordSRV pair that cannot be imported without overwriting a different authoritative current link, or invalid legacy identity data.
- The bridge deliberately leaves authoritative current state untouched.

Classification:

- One legacy identity mapping is **CONFLICTED**.
- This is not evidence that the collector is down.
- Do not expose the affected player/Discord identity in ordinary AI responses.

## Plan analytics

Status on current SMP: **UNAVAILABLE**

Evidence:

- No Plan plugin is present in the fresh 102-JAR SMP inventory.
- WarzoneDuels explicitly logs that its Plan integration cannot start because the Plan DataExtension class is unavailable.
- Currency and Commend still have Plan integration enabled in configuration.

Truth resolution:

- Runtime absence wins over enabled config flags.
- Do not answer that Plan-backed SMP integrations are currently active.
- This does not prove Plan is absent from every other server/network component; those targets require fresh independent evidence.

## Known runtime degradations tracked separately

- RoseChat/Tags presence build mismatch — issue #36.
- EnthusiaStaff ProtocolLib fake-entity cheat-test path fail-closed — evidence on EnthusiaStaff issue #236.
- Advancement Discord icon rendering falls back to text-only — issue #37.
- PoseProbe local diagnostic plugin is enabled in production and remains a cleanup/provenance candidate.

