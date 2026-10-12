# AI-OFF SMP restart evidence — October 12, 2026

**Purpose:** preserve meaningful before/after Spark and LoreItems observations around the owner-planned ~16:22 EDT SMP restart. This is a **read-only collection plan**, not permission to deploy new JARs, restart the SMP on the owner's behalf, start Qwen inference, alter SFTP/files/SQLite, or change CPU affinity.

**AI environment:** owner reported the separate Bloom AI server STOPPED during 15:05–15:33 EDT evidence. Independently reconfirm the stopped state for each new window. All timestamps below should be captured at source with both local and UTC times; do not silently infer current offset.

## Established pre-restart evidence (do not substitute for fresh readings)

- [Health NIdZDhD9Fi](https://spark.lucko.me/NIdZDhD9Fi) 15:05 EDT: 19 players; 20 TPS; 1m tick mean/median/p95/max **23.38/22.38/34.57/59.26 ms**; many loaded chunks; previous spikes existed.
- [Health RxwKOxCr9J](https://spark.lucko.me/RxwKOxCr9J) 15:32 EDT: 18 players; 20 TPS; 1m mean/median/p95/max **16.03/14.50/26.03/206.44 ms**. This variation is not itself a before/after fix comparison.
- [Slow-tick profiler SlDVhrrf6a](https://spark.lucko.me/SlDVhrrf6a) ~15:06–15:33 EDT: Server-thread sampler >100 ms captured **11 of 32,169 ticks**; traces implicate synchronous Staff → RoseChat vanish presence rendering and LoreItems chunk-unload/queued inventory scanning. These are *selected slow-tick sample weights*, not absolute plugin MSPT shares; see [EnthusiaStaff #545](https://github.com/wsg138/EnthusiaStaff/issues/545) and [LoreItems #71](https://github.com/wsg138/EnthusiaLoreItems/issues/71). Third-party Trivia is owner-excluded.
- LoreItems metadata reported version 1.0.2. **No exact current-loaded JAR path and SHA256 established**, so these captures must not be called a post-optimized release benchmark.

## Operator collection checklist — BEFORE the planned restart

1. Confirm **AI is STOPPED**, note Minecraft player count and whether piglin/mob/hopper farms are loaded, and label this as **PRE-RESTART, AI-OFF**. No deliberate farm activation or stress.
2. Run **`/spark tps`** and preserve the whole output with local wall time. Run **`/spark health upload`**, save exact URL and timestamp. The prior reports above are already good preliminary data, but the latest normal-play snapshot is preferable.
3. Open the existing LoreItems diagnostics/staff GUI **if available in the running JAR**, and take a screenshot with displayed process uptime, counters and queue state. Repeat a second screenshot **3–5 minutes later in the same JVM** if time permits. Capture these counters if displayed:
   - physical scan queue current/peak/capacity; accepted, rejected event/periodic, and distinct player-vs-chunk reject sources;
   - player/chunk scan attempts, completed/failed/skipped/truncated, per-invocation and full-drain peaks if available;
   - hopper synchronous event and deferred reconciliation counts, total/peak time;
   - deferred player coalescing, persistence backlog/in-flight/failures, unexpected identity warnings.
4. Screenshot or document the **current deployed plugin names and version metadata**. The **hash/path must be marked UNVERIFIED** unless determined from the actual current plugin file through an authorized read-only host-key-verified operation; a CI artifact hash or plugin.yml version is not a substitute. Do not disclose passwords or full private filesystem paths in public issues.
5. Preserve existing Spark and GUI files locally. Counter values may reset at JVM stop; **you cannot recover their previous totals afterward**.

### Time-critical rule

If fewer than 3–5 minutes remain, capture **one** fresh GUI screenshot and Spark health/TPS rather than delaying the planned maintenance. Do **not** hold the SMP restart for an optional profile. Do not launch 5-minute profiling right before a restart or interrupt an existing profiler unsafely.

## Restart/release boundary

A normal restart with **no plugin file changes** is a *restart/stability* comparison, not a deployment of a LoreItems optimization. Even a newly displayed `version: 1.0.2` is not proof of which JAR was loaded.

If someone plans to stage a replacement JAR at this restart, **stop and apply a separate release gate** before any write: frozen reviewed source/CI and exact inner-JAR checksum; verified current active path and one active .jar; SQLite WAL-consistent backup **of the entire LoreItems DB/config/groups state**, successful backup integrity check and disposable restore; compatibility with Staff/RoseChat plugin APIs; approved maintenance/restart and rollback plan. A live SQLite DB-only copy may not be consistent. Existing LoreItems draft #70/#75/#76/#77/#78 and Staff/RoseChat worker changes are **not automatically authorized** for this restart.

No worker may alter live JVM, model, CPU affinity, production config, plugins or database from this runbook.

## Operator collection checklist — AFTER normal restart

1. Record restart time, new JVM uptime, Paper/JVM versions, total loaded plugin JAR names, whether *any* plugin changed, and exact **current loaded JAR SHA** only if independently verified. Confirm **AI remains STOPPED**.
2. Let startup/rejoin/chunk warmup settle under ordinary activity; **note the actual warmup duration** and do not label startup TPS a matched steady-state sample.
3. With representative player count/chunks/entities/farm status, run **`/spark tps`**, **`/spark health upload`**, then repeat the health capture and LoreItems GUI screenshot **3–5 minutes later in the same server process**. Record precise local+UTC timestamps, player count, and approximate farm/activity status for each.
4. If occasional high MSPT ticks remain and owner accepts low sampling overhead, optionally collect **one** targeted five-minute Java main-thread Spark slow-tick profile using the installed Spark version's supported command (e.g. `/spark profiler start --only-ticks-over 100 --timeout 300`). The threshold may miss 50–99ms degradation; a zero-event result is not proof of zero plugin overhead. Preserve URL/start/end/tick count; don't run concurrent profiler tasks.
5. In the **same process** only, calculate a cumulative counter's delta as snapshot B minus A, divided by measured elapsed time if a rate is needed. Peak values are maxima and **never** differences. **Never subtract pre- and post-restart cumulative totals from one another.** New counters may not exist if the new instrumentation has not actually been deployed.
6. Record any abnormal SQL migration, duplicate identities, inventory-tracking problems, missing RoseChat presence, staff vanish/visibility regression, active player complaints or GC issues. Those are correctness/rollback review signals, not merely performance measurements. Do not try to induce problematic state on live players.

## How to interpret the results

**Good evidence:** each report states a real source URL or local evidence file, start/end/timezone, whether AI was stopped, server uptime, current actual JAR provenance status, players, loaded chunks, entities and farm status, TPS and MSPT distribution, Spark Java Server-thread path and LoreItems counters. Keep all original captures.

**Not valid:** comparing high pre-restart farm activity with low post-restart load and calling the difference a fix; equating aggregate system CPU% with Minecraft main-thread availability; multiplying selected slow-tick samples into all-tick overhead; claiming merged source or CI builds prove the live JAR; missing or estimated p99/max; assuming an idle model container is equivalent to AI fully stopped.

**Result classes:**
- `RESTART_OBSERVATION_ONLY`: no verified plugin change; observe continuity/uptime differences.
- `PRE_RELEASE_AI_OFF`: separate AI stopped but optimization running binary not proven.
- `POST_RELEASE_AI_OFF_CANDIDATE`: verified deployed optimized JAR and normal startup, but baseline matching/health still in progress.
- `POST_RELEASE_AI_OFF_STABLE`: deployed hash + tracking correctness + matched repeat measurements reviewed (this is **not** approval for inference).
- `INCONCLUSIVE`: sources too sparse, mismatched or confounded; retain evidence and list what is missing.

Send reports to [EnthusiaAI benchmark issue #119](https://github.com/wsg138/Enthusia-AI/issues/119) and cross-link LoreItems #71 / Staff #545 when applicable. **Do not start the four-thread Qwen3-30B benchmark.** An OFF→IDLE→bounded-INFERENCE→RECOVERY comparison requires a *separate* owner/provider-approved schedule, synchronized CPU/process evidence and immediate AI-stop criteria.

## Pasteable evidence worksheet

```text
Capture label: PRE-RESTART AI-OFF / POST-RESTART AI-OFF
Local time/timezone, UTC time:
SMP restart time and uptime:
Bloom AI service: STOPPED / UNVERIFIED
SMP Paper build / Java version:
Online player count, activity/farm status:
Loaded chunks / total entities / zombified piglins / largest region:
Loaded LoreItems JAR pathname + SHA256: VERIFIED (proof) / UNVERIFIED
EnthusiaStaff/RoseChat actual JAR hashes: VERIFIED (proof) / UNVERIFIED
/spark tps full output:
Spark health link(s), capture times:
Optional Spark main-thread profile URL + exact duration:
LoreItems diagnostic screenshot A + timestamp:
LoreItems diagnostic screenshot B + timestamp (same JVM):
Counters that were missing/unavailable:
Notes: GC, restarts, lag complaints, staff presence, tracking/identity warnings:
Files or plugin builds changed during restart:
```

This is a reporting template, not an automatic host data collector.