# Deep flamegraph review: matched SMP Spark profiles, October 9, 2026 EDT

**Source profiles:**
- AI OFF: https://spark.lucko.me/vKZdMAkBX9 (180.323 sec, 13–14 players)
- AI ON: https://spark.lucko.me/92tX2g1hoK (240.347 sec, 13–14 players)
- Source files personally decoded from the owner-supplied protobuf `.sparkprofile` attachments using spark schema (SamplerData/ThreadNode/StackTraceNode/WindowStatistics).
- Engine=ASYNC, mode=EXECUTION, sample interval=10 ms, aggregator=SIMPLE / thread grouping BY_POOL. **These are sampled inclusive execution/wall stack times; do not assert they are precise exclusive CPU seconds.** Samples are aggregated into 60-second windows, NOT individual tick call stacks.

## Finding

Slow AI-on minutes (00:27:18–00:29:18 UTC) at 14 players lost TPS: 16.92 and 16.67, max ticks 1,253 ms and 1,101 ms, versus near 20 TPS with AI off. Main-thread `MinecraftServer.tickServer` appeared on the stack ~53 sec in the first slow minute, vs ~21 sec baseline at 14 players; waiting/parking declined from ~38 sec to ~3 sec. The whole main thread became substantially busier/slower, not just one offender.

### Main-thread stacks, one-minute inclusive sampled time

| Stack / method | AI OFF (last minute, 14 players) | AI ON (slow minute #2, 14 players) | AI ON (slow minute #3, 14 players) |
|---|---:|---:|---:|
| TPS | 19.92 | 16.92 | 16.67 |
| Tick count | 1194 | 980 | 980 |
| `MinecraftServer.tickServer` | 21.21s | 52.91s | 45.60s |
| `CraftScheduler.mainThreadHeartbeat` (all scheduled tasks) | 6.63s | 18.46s | 17.00s |
| EnthusiaLoreItems `PaperTemplateUpdateListener` / `PaperTemplateUpdateAccessController.scan` | **2.33s** | **9.64s** | **10.20s** |
| EnthusiaLoreItems `PaperDeferredMainThreadActions.execute` | **2.99s** | **5.70s** | **4.06s** |
| `EntityTickList.forEach` | 7.98s | 14.58s | 10.99s |
| `Villager.tick` (included in entity ticking) | 3.62s | 5.44s | 2.61s |
| `ServerChunkCache.tickChunks` (included in world tick) | 3.23s | 9.80s | 8.11s |
| Main-thread waiting (`recordTaskExecutionTimeWhileWaiting`) | 38.38s | 3.19s | 11.40s |

**Overlapping inclusive times must never be summed indiscriminately:** villagers are part of entity ticking, chunks part of world ticking, LoreItems tasks part of scheduled tasks, etc.

## Most actionable plugin hotspot

`net.enthusia.loreitems.paper` was one of the clearest user-plugin hotspots.

1. `PaperTemplateUpdateListener -> PaperTemplateUpdateAccessController.drainOne -> PaperTemplateUpdateScanner.processPass -> PaperTemplateUpdateItemReference.resolve`: 8.96 seconds of sampled time during slow minute #2, dominated by repeated `PaperInventoryReference.Block.resolve -> CraftBlock.getState -> CraftBlockStates$BlockEntityStateFactory.createBlockState` (~5.20s), plus `PaperTemplateUpdateItemReference.readAt -> shulkerChild -> CraftMetaBlockState.getBlockState` (~3.62s). In slow minute #3, resolving references rose to ~9.52 seconds.
2. `PaperDeferredMainThreadActions -> PaperPhysicalTrackingListener.scanPlayer -> PaperPhysicalInventoryScanner.scanPlayerUnique -> PaperTrackedItemCollector.hasNestedIdentityEvidence` (5.22 seconds slow minute #2): expensive `CraftMetaBlockState.getBlockState` (~3.82s) and `hasIdentityEvidence` (~1.09s).
3. We inspected the source on the default branch of `wsg138/EnthusiaLoreItems`: the `PaperTemplateUpdateItemReference.shulkerChild` method calls `blockMeta.getBlockState()`; `PaperTrackedItemCollector.hasNestedIdentityEvidence` likewise calls `blockMeta.getBlockState()` while checking nested inventory identities. Those APIs construct block-state snapshots and are measurably heavy in this profile. Repo commit/version is **not verified identical** to the production plugin Jar.

**Optimization review, no deployment:** profile exact implemented version and scan frequency; avoid unnecessary block-state snapshot/materialization on uninteresting items; reuse decoded shulker state within a scan where semantically safe; fast-path material / identity evidence when safe, avoid repeatedly resolving loaded block inventories every scan pass, time-budget scanning and de-duplicate/schedule only changed inventories. Preserve uniqueness/security semantics (don't disable tracking casually). Code fixes require tests/reviews.

## Other SMP hotspots

- Vanilla **entity ticking**, especially `Villager.tick -> Mob.serverAiStep`, as well as other mobs, expanded. Entity tick 7.98s (baseline last minute) -> 14.58s (worst AI-on minute).
- Vanilla **chunk ticking**, including `NaturalSpawner.spawnCategoryForChunk`, random ticks, and chunk collection, expanded. `ServerChunkCache.tickChunks` 3.23s -> 9.80s.
- Several independent main-thread paths were much slower simultaneously, supporting shared-system performance interference as a hypothesis, though changes in player/world activity or plugin scan workload also contribute. Spark profiles cannot measure host CPU scheduler migrations/steal, cache pressure, per-core utilization or process-to-process causal effect.

## Individual long ticks: cannot attribute from these two profiles

The worst individual AI-on ticks were ~1,253ms and ~1,101ms. The profiles' `WindowStatistics` record **maximum tick length**, but their `SamplerMetadata.DataAggregator` is **SIMPLE**, not a filtered `TICKED` threshold aggregator. Therefore the call trees represent overall 60-second windows; they do not preserve what happened inside any one of those exact very long ticks. Do not claim LoreItems caused the 1.253-second tick.

If an owner-approved future diagnostic is required, on SMP *without adding a new competing AI workload*, use a time-bounded `spark profiler start --timeout 120 --only-ticks-over 100` to focus on ticks longer than 100ms. On the live server this should be done only at a safe time; no instruction to reproduce AI-on lag now. Spark docs: https://github.com/lucko/spark-docs/blob/master/docs/commands.mdx

## Conclusion

Current evidence identifies a significant **EnthusiaLoreItems main-thread container/shulker scanning optimization opportunity** independently of infrastructure discussions, plus vanilla entity and chunk ticking. CPU contention remains consistent with correlated multi-system slowdown and recovery, but not proved as the sole cause. Keep AI paused, pursue plugin performance analysis safely and show Bloom both full profile links with the specific stack evidence. No code changed, no production deploy or restart.
