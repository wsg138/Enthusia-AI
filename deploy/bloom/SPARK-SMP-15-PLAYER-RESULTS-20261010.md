# SMP 13–14-player matched AI-off / AI-on benchmark results

**Recorded 2026-10-10 UTC (October 9 evening EDT). Owner-provided primary artifacts:**
- AI **OFF**, live SMP spark: https://spark.lucko.me/vKZdMAkBX9; original binary `vKZdMAkBX9.sparkprofile`.
- AI **ON**, live SMP spark: https://spark.lucko.me/92tX2g1hoK; original binary `92tX2g1hoK.sparkprofile`.
- Owner-provided Bloom log `Pasted text(20261010-002948).txt` (run output embedded; no workload UTC timestamps).
- Sampling interpretation based on `spark_sampler.proto` and `spark.proto` from lucko/spark. One-minute `WindowStatistics` are **capture-local**, unlike rolling last-five-minute MSPT, which includes prior history.

## Bottom line

**FAILED shared-host performance gate / NO GO for running the four-thread 30B AI inference alongside live SMP at real player load.**

Unlike the old 0–4-player baseline, the two measurements have comparable **13–14 players** and were recorded within minutes of each other. TPS stayed ~20 with AI stopped. During the AI-on profile it fell to **16.92 and 16.67 TPS in consecutive one-minute windows**, and returned to **19.97 TPS in the final one-minute window**, consistent with a ~150-second inference workload ending. Evidence strongly suggests shared-host interference but exact AI workload timing was not recorded in this live run and activities are not identical: this is **strong correlation, not an experimentally isolated proof of cause**.

## Complete 60-second window data

**AI OFF** profile total: 2026-10-10 00:22:49.011–00:25:49.334 UTC, 180.323 s, 3,595 ticks.

| One-minute UTC window | Players | TPS | Median MSPT | Max tick | JVM process CPU | System CPU |
|---|---:|---:|---:|---:|---:|---:|
| 00:22:49–00:23:49 | 13 | 20.0000 | 15.301 ms | 162.114 ms | 3.08% | Not available |
| 00:23:49–00:24:49 | 13 | 20.0000 | 14.888 ms | 120.421 ms | 2.94% | Not available |
| 00:24:49–00:25:49 | 14 | 19.9170 | 14.963 ms | 386.584 ms | 2.82% | 2.25% |

**AI ON** profile total: 2026-10-10 00:26:18.764–00:30:19.111 UTC, 240.347 s, 4,338 ticks.

| One-minute UTC window | Players | TPS | Median MSPT | Max tick | JVM process CPU | System CPU |
|---|---:|---:|---:|---:|---:|---:|
| 00:26:18–00:27:18 | 13 | 19.6883 | 31.928 ms | 276.726 ms | 5.44% | 5.47% |
| 00:27:18–00:28:18 | 14 | **16.9211** | **41.229 ms** | **1,253.189 ms** | **7.47%** | **7.38%** |
| 00:28:18–00:29:18 | 14 | **16.6701** | 38.321 ms | 1,101.004 ms | 6.16% | 6.39% |
| 00:29:18–00:30:18 | 14 | 19.9667 | 17.309 ms | 341.107 ms | 3.81% | 3.99% |

**Other comparisons / limitations:**
- Baseline last-one-minute MSPT mean **19.328 ms**, p95 **37.779 ms**; AI-on ending last-minute **20.399 ms**, p95 **34.974 ms**. **Do not compare these ending snapshots to measure the overlapping inference period: the AI-on profile recovered during its last minute.**
- Baseline ending rolling-five-minute p95 **37.870 ms** versus AI-on rolling-five-minute p95 **74.370 ms**; this is suggestive but these rolling stats include time *outside* each profile and have unmatched windows.
- JVM heap at the capture endpoint: AI off **8.217 GB used / 18.874 GB committed**; AI on **8.919 GB used / 18.874 GB committed**. Host physical memory 39.45 GB used baseline vs 39.60 GB AI-on endpoint. No host RAM exhaustion shown by these endpoints.
- AI-off windows reported 6.3–7.1k chunks while the two slowest AI-on windows reported ~2.3–2.7k, so a simple higher loaded-chunk count does not explain the difference. However activity/entity/plugin work can differ, and spark is not a native sampler of the separate llama.cpp process.
- System CPU readings are spark's fractions, not a direct AI container usage measurement. They cannot establish core affinity, cgroup throttling or the full host bottleneck alone.

## AI load outcome and operational problems

The Bloom console reports **PASS**, **54 serial requests in 150.6 seconds**, mean reply **2.8 seconds**, maximum **6.1 seconds**, **13,976 MiB peak sampled memory**, **45,776 MiB limit**, **four threads**, **2,048 context**, SHA model/binary verification PASS, no OOM. This test proves AI inference completed, **not** safe co-location or improved factual quality. Answers still repeat the known incorrect Enderman-water and redstone comparator claims, with other inaccuracies.

**Important: the Bloom runtime used an outdated one-shot load script**: it printed PASS, exited with code 0, Pterodactyl marked it crashed, and automatically restarted another model verification and startup until the owner stopped it. Unlike the latest repository script (which idles after a completed run and includes explicit UTC markers), the deployed script did **not** print workload UTC timestamps and did **not** use an idle-after-finish guard. Do not run it again without reconciling the staged script version. The second automatic startup was stopped and emitted a FAIL diagnostic `inference-server-exited-before-ready`; this is not evidence the original 150s workload failed.

## Decision and next safe actions

1. **Suspend any automatic/sustained 30B load on the SMP's shared physical host**. Keep the AI-only Bloom split stopped after profiling; no live SMP restart/change.
2. Record this as a **failed capacity/performance gate for the 4-thread 30B configuration**; do **not** approve production Discord/SMP deployments, increase threads or merge HOLD PR #118.
3. Diagnose physical core sharing, cgroup CPU quotas/affinity/throttling and workload timing in a separate controlled investigation if infrastructure/provider allows, comparing equal player activity; include actual AI container CPU and IO, disk verification/startup impact, and the latest script UTC markers. **Do not automatically order another SMP experiment.**
4. Evaluate whether a bounded **1–2-thread serialized** inference workload with explicit OS quotas/CPU isolation could coexist **only after performance risk is approved**, accepting possibly worse response time. Alternatively use **separate physical host or paid GPU only with cost approval**. Do not silently replace 30B with the earlier inaccurate 1.7B.
5. Continue only offline and isolated development of source-grounded Minecraft and Enthusia knowledge retrieval, controlled public web search, and staged agent orchestration. Hosting suitability is separate from model-quality work.
