# Real 30B load test vs live SMP Spark (2026-10-09)

Evidence: owner-uploaded Pasted text(20261009-232919).txt console, rpSVK9WeNf.sparkprofile and prior xZbslOOPs3.sparkprofile. The user also posted https://spark.lucko.me/RGhtIqh7YL; the uploaded profiler file has a **different filename token** and has NOT been independently confirmed to be the same viewer report. This comparison is based on the actual uploaded binaries and logs.

## AI load test

- Dedicated AI split CC19EA3C, Node 25.9, CPU-only Qwen3 30B-A3B Q4_K_M, four llama threads, context 2048.
- Completed 58 requests during 151.4 seconds, average 2.6 seconds and maximum 5.5 seconds. PASS, exit code 0, no OOM, binary/model verified, no external model download.
- Peak cgroup memory 13,965 MiB of 45,776 MiB.
- **Critical:** Pterodactyl marked clean exit code 0 as crashed/offline and automatically restarted the one-shot test! A subsequent partial second run (20 requests) appears in the same pasted console. Owner should manually STOP the AI server and ensure it stays stopped after benchmarking.

## SMP measurements

**Earlier AI-off benchmark** xZbslOOPs3.sparkprofile: 2026-10-09 21:46:33.980–21:49:34.552 UTC (180.6 sec); 4 players in the three one-minute summary windows, 0–4 across historical player metrics. TPS approximately 20, last-minute MSPT mean 9.385ms, p95 14.640ms.

**New attached profiler** rpSVK9WeNf.sparkprofile: 2026-10-09 23:25:11.957–23:27:12.925 UTC (**121 seconds, not 180**); **8 players** in both one-minute windows. First window TPS 19.9667, median MSPT 19.183ms, maximum 333.271ms. Second window TPS 20.0000, median MSPT 22.778ms, maximum 120.532ms. Rolling last minute at end: MSPT mean **23.913ms**, p95 **42.388ms**, TPS ~20.

To avoid misleading comparisons between 4- and 8-player samples, the NEW file also embeds historical rolling time-series preceding the profiler window. The five-minute **23:20–23:25 UTC 8-player** interval was compared against the profiler's **23:25:12–23:27:13 UTC 8-player** interval.

| Signal | Before new profiler (8 players) | New profiler window (8 players) |
|---|---:|---:|
| Sample count (rolling MSPT) | 30 | 12 |
| Mean of sampled rolling MSPT means | **9.19ms** | **17.94ms** |
| Mean of sampled rolling MSPT p95 | **17.94ms** | **32.29ms** |
| Largest rolling sample maximum tick | **108.9ms** | **333.3ms** |
| Mean Spark system CPU | **1.55%** | **5.28%** |
| Mean SMP Java CPU | **1.58%** | **4.66%** |
| Player count | 8 throughout | 8 throughout |

**Methods/caveats:** These are means of separately sampled rolling metrics, not the true pooled/raw tick p95. Profile overlap with AI start/end times has not been independently time-stamped; correlation with AI activity is likely but **not causation proof**. Player activities and background work could differ even with the same count. TPS remained near 20, but tick-processing headroom deteriorated substantially. A controlled recovery (AI OFF, similar activity/players) is required. Total system physical RAM at new profile end was ~53.33 billion bytes / 201.68 billion available; swap used ~3.20 billion bytes. Shared-host contention appears more likely than capacity exhaustion, but need host CPU/disk evidence.

## Follow-up / guardrails

1. Keep AI split **stopped** after test completion to prevent automatic reruns. Do not increase threads or the 48GB RAM limit. Do not touch live SMP.
2. Capture a 2–3 minute **AI-off recovery Spark** with comparable ~8-player load, to see if MSPT recovers.
3. If still needed, prepare an owner-approved separate test with **two inference threads**, no auto-restart, and tightly aligned timestamps. Stop AI for sustained tick-performance degradation. Full-length loaded-player proof remains outstanding.
4. Do not treat the 58 repeated questions as independent factual accuracy validation. The 30B model is still only 6/9 on elementary Minecraft factual answers. Grounding and factual evaluation must precede public release.

## Bloom MAIN FILE field — IMPORTANT

Owner screenshot proves **MAIN FILE length <= 16 characters**. The previously recommended filename bloom-30b-loadtest.js is too long for the panel field. The owner worked around this. For future deployments use short **bloom-30b.js** (12 characters) or **ai-load.js** (10 characters) with only one root *.js file and correct generic Node startup. The repository's long source filename need not equal the panel entrypoint name. This issue and the automatic restart must be addressed in every future setup guide.

No GitHub merge, no production rollout, no model retraining or new SMP changes were made by this analysis.
