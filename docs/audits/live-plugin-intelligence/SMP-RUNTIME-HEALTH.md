# SMP runtime health — fresh production observations

Evidence: owner-authorized read-only inspection of the fresh SMP runtime log corresponding to the 2026-10-05 deployment snapshot.

Privacy rule: this document intentionally omits player names, UUIDs, IP addresses, chat contents, and other per-player identifiers. It records only system-level health facts.

## Summary

| System | Status | Evidence |
|---|---|---|
| PieCloak | DEGRADED | 193 WARN lines; 166 post-spawn reconciliation queues expired and were quarantined |
| EnthusiaLoreItems | DEGRADED | physical-tracking scan queue reached saturation 45 times |
| RoseChat ↔ EnthusiaTags | DEGRADED | current RoseChat artifact lacks required PresenceMessageEvent API |
| RoseChat ↔ EnthusiaStaff | DEGRADED | 9 vanish presence transitions failed with missing BridgeRegistration.renderPresence API |
| EnthusiaStaff fake-entity cheat tester | DEGRADED / FAIL-CLOSED | ProtocolLib adapter failed; fake-entity evidence disabled safely |
| EnthusiaAdvancements Discord icons | DEGRADED / SAFE FALLBACK | icon rendering fails; announcements continue text-only |
| LumaGuilds claims | DISABLED BY CONFIG | startup confirms all claim features unavailable |
| LumaGuilds Plan integration | UNAVAILABLE | Plan not installed on current SMP |
| WarzoneDuels Plan integration | UNAVAILABLE | runtime explicitly failed to load Plan DataExtension |
| EnthusiaPlaytime Discord numeral role sync | INTERMITTENT | 3 retry warnings observed |
| EnthusiaDonorNPCs name resolution | DEGRADED / NOISY | one donor identity repeatedly failed name lookup (60 warnings) |
| LumaGuilds ↔ EnthusiaCurrency/Vault economy | ACTIVE AFTER STARTUP RETRY | LumaGuilds starts before the economy provider exists, then later hooks TokenEconomy after EnthusiaCurrency registers |
| InteractiveChatDiscordSrvAddon resource pack | DEGRADED / FALLBACK | resource-pack download failed; addon loaded Default + local pack.zip |
| InteractiveChat / DiscordSRV bridge | ACTIVE | runtime confirms hooks and inbound/outbound listeners |
| EnthusiaStaffAuthorityBridge | ACTIVE WITH CONFLICTED LEGACY LINK | collector operates every minute; one legacy identity conflict is often preserved rather than overwritten |

## PieCloak

Observed:

- 193 PieCloak WARN lines in the inspected runtime log.
- 166 use the primary message shape that a post-spawn reconciliation queue expired because no spawn packet arrived within 16 ticks.
- Current code removes the pending queue and suppresses further unknown-entity reconciliation for that viewer/entity ID until a spawn/destroy reset occurs.

Interpretation:

- The suppression behavior is intentionally bounded and prevents endlessly rebuilding an unresolved queue.
- The frequency is a current production degradation and may affect entity/block-entity visibility correctness until the reset condition occurs.
- Tracked in wsg138/PieCloak#17.

## EnthusiaLoreItems

Observed:

- 45 `Lore-item scan backlog is full; previous durable evidence was preserved.` warnings.

Current source behavior:

- new tracking scan request is rejected when the bounded queue is full;
- `tracking.rejected` increments;
- previous durable evidence remains preserved;
- saturation clears when the queue drains.

Interpretation:

- Safe for TPS/durable-history preservation, but fresh physical-tracking evidence can lag or be skipped under sustained load.
- Tracked in wsg138/EnthusiaLoreItems#39.

## RoseChat deployment/API mismatch

Current production RoseChat SHA does not match the known-good presence-capable current source artifact.

Impacts observed:

1. EnthusiaTags cannot bind PresenceMessageEvent and uses fallback/default audience behavior.
2. EnthusiaStaff recorded 9 vanish presence transition failures with a NoSuchMethodError for BridgeRegistration.renderPresence(PresenceContext).

Interpretation:

- One wrong/older RoseChat deployment affects at least two first-party integrations.
- This is higher leverage to repair than independently changing Tags/Staff around the wrong artifact.
- Tracked in Enthusia-AI issue #36.

## EnthusiaStaff cheat-test fake entities

Observed:

- ProtocolLib fake-entity adapter throws on current Paper/ProtocolLib combination.
- Feature logs that fake entities are fail-closed.

Interpretation:

- No unsafe automatic behavior was observed.
- The evidence-gathering feature is unavailable and must not be represented as healthy/current.
- Production evidence attached to EnthusiaStaff issue #236.

## Advancement Discord icon rendering

Observed:

- Discord advancement icon rendering throws through InteractiveChatDiscordSrvAddon on the current Paper build.
- EnthusiaAdvancements explicitly falls back to text-only Discord announcements.

Interpretation:

- Announcement path remains usable.
- Image/icon enrichment is degraded.
- Tracked in Enthusia-AI issue #37 because the GitHub integration does not have issue-write permission on the upstream first-party repo.

## EnthusiaPlaytime Discord role synchronization

Observed:

- 3 warnings that a Discord numeral role sync failed and would retry.

Classification:

- INTERMITTENT, not yet a confirmed persistent outage.
- Do not open a separate defect from this evidence alone unless retries are shown to remain unresolved or player roles diverge.

## EnthusiaDonorNPCs name resolution

Observed:

- 60 repeated warnings for one donor NPC identity whose name lookup fails and has no distinct fallback.

Classification:

- persistent data/display degradation and log noise;
- no evidence from this warning alone of broader DonorNPC failure;
- candidate for targeted cleanup after higher-priority issues.

## LumaGuilds / EnthusiaCurrency economy startup ordering

Observed sequence:

- 00:00:59 — LumaGuilds initially reports no Vault Economy provider.
- 00:01:08 — EnthusiaCurrency reports that it registered itself as the Vault economy provider.
- 05:46:22 — LumaGuilds reports `Successfully hooked into economy provider: TokenEconomy`.

Classification:

- ACTIVE after delayed provider registration/retry.
- The early error is a startup-order transient, not evidence that the guild bank is currently down.
- Player-facing support may treat the current economy-backed guild-bank path as available unless newer runtime evidence contradicts it.
- Engineering follow-up may still reduce the alarming startup log or wire the provider deterministically on service registration.

## Safe retrieval behavior

When these systems are discussed, Enthusia AI should:

- prefer current runtime status over source intent;
- distinguish DISABLED, DEGRADED, FAIL-CLOSED, INTERMITTENT, and ACTIVE;
- avoid exposing stack traces or internal class names to ordinary players;
- give a simple user-facing effect, e.g. “Discord advancement images are having an issue, but the text announcement still works”;
- only provide staff-level technical details when the request/authorization context warrants it.