# Spark profile plan — Enthusia AI colocated with LIVE SMP (2026-10-09)

## Status / authorization

**PLAN ONLY — do not run anything yet.** The owner is completing the final review of the `SMP Temp` server `CC19EA3C` before separately authorizing the wipe and repurposing it for AI staging. Do NOT stop, wipe, migrate or edit the temporary or production SMP from this runbook. The owner said Bloom may **not** expose a CPU quota setting. After authorized wipe, configure **48 GB** memory limit and retain **50 GB** disk. The 30B bench has **4 llama.cpp inference threads**, 2048 ctx and 80% of the 48GB cgroup as its stop threshold. An unset/32-core Pterodactyl CPU allocation does NOT guarantee host CPU isolation.

## Primary live SMP Spark commands

Run on the **live SMP game's** chat with slash; in its game-server console use the same command **without leading slash** if necessary (console syntax varies with panel).

Capture comparable *unfiltered* all-thread profiles, one phase at a time, using exactly:

```
/spark profiler start --timeout 180 --thread * --interval 10
```

Command flags are documented in https://spark.lucko.me/docs/Command-Usage : all SMP JVM threads, 10-millisecond sample interval (lower profiler overhead than default 4ms), 180 seconds automatic completion/upload. **Do not run multiple Spark CPU profilers concurrently**. Collect each generated `https://spark.lucko.me/...` viewer URL. If uploads are undesirable or fail, use `/spark profiler stop --save-to-file` to save a `.sparkprofile` on the live SMP, then share only approved results.

During each phase, optionally run:

```
/spark tps
/spark health show --memory
/spark gc
```

The profile viewer also has time-series CPU(process/system), TPS, MSPT, player count and memory information. Do not call `/spark heapdump`, force GC, or enable allocation profiling during initial trials; those are extra load and not needed for initial co-location diagnosis.

## Controlled sequence

0. Owner completes migration and confirms `CC19EA3C` wiped / no live players, then reconfigures ONLY that former temp server. Keep AI off. Wait for live SMP stability following its own restart; record concurrent player count, location/activity, chunks, other events, host processes; don't compare dissimilar load (0-player baseline vs peak-hour test).
1. **Baseline** (AI stopped): run 180-second Spark main/all-thread profile, save viewer URL, record exact local start/end clock times plus `/spark tps` and `/spark health show --memory`. Confirm 20 TPS where expected and capture 95th percentile MSPT and max tick.
2. **Download/verify vs inference are different stressors.** Downloading and hashing an ~18.6 GB GGUF can affect shared disk/IO and page cache separately from CPU inference. The one-shot staging script combines download, hash, load and 15 prompts. If download takes longer than 180 seconds, take separate Spark window for download and for inference; record script's `[qwen-30b]` timing markers and host CPU, disk throughput, memory/swap pressure if available.
3. **Active AI**: start the **same** 180-second Spark profiler shortly before invoking the authorized `bloom-30b.js` on the wiped `CC19EA3C` service. Keep profiler active across model load + as much Q01–Q15 inference as possible. Record timestamp of model download/verification, first Q01, last Q15 and exit. If the benchmark finishes early, note that the profiling window includes idle time. Do not attribute any unaligned spike to AI without correlating timestamps.
4. **Recovery**: once AI process fully exited and background disk IO settled, take a third 180-second Spark profile and snapshot.
5. Compare baseline/active/recovery at **similar player counts**: 1m/5m TPS (20 target), median and **p95 MSPT**, maximum tick tail, CPU(process), CPU(system), GC count/pause duration, physical RAM free, swap activity, player ping where useful. The Spark profiles show SMP JVM stacks but *not* native llama.cpp stacks: use Bloom AI process RAM/CPU and host metrics to attribute cross-process contention. Spark's system CPU percentage can expose overall pressure, but it does not prove the source.
6. **Abort/roll back** if meaningful sustained TPS drops or p95 MSPT rises materially (e.g. increases >10ms compared with matched baseline, approaches 40–50ms, or repeated >50ms stalls), sustained swap/major faults or significant player impact. These are cautious pilot review criteria, not universal performance thresholds. Stop the AI bench; don't shut down SMP; diagnose CPU core contention, shared host RAM/page cache, disk IO, power throttling. If needed rerun with llama.cpp 2 threads or reduce download/verification disk load, and repeat matched profiles.

Spark command reference: https://spark.lucko.me/docs/Command-Usage .
TPS/MSPT guide: https://spark.lucko.me/docs/guides/TPS-and-MSPT .

## What the owner should send

Send three distinct Spark viewer links labeled **baseline**, **AI**, **recovery**, plus the stage timestamp and `bloom-30b-report.json` (no credentials). If there was a material drop, send an extra screenshot of Bloom AI CPU and the SMP CPU graphs at the same time.

Do not treat `bloom-30b.js` PASS as model accuracy pass. The fixed question set is meant to compare the 30B model with 1.7B's observed **2/9** vanilla factual answer baseline. No live Discord/production integrations or paid GPU rental are part of this step.
