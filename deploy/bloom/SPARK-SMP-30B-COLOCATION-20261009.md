# SMP and Qwen3 30B shared-host spark comparison — 2026-10-09

## Sources and scope

- New SMP profiler: https://spark.lucko.me/CMnQiaRc47 (owner attached `ZdU8DeADND(1).sparkprofile`).
- Pre-AI SMP baseline: https://spark.lucko.me/xZbslOOPs3 and `deploy/bloom/SPARK-SMP-BASELINE-20261009.md`.
- Separately reported Qwen3-30B AI load test: 58 requests in 151.4 seconds; 2.6-second mean, 5.5-second maximum response; sampled peak 13,965 MiB; 4 inference threads; no OOM. The load-test report does **not** provide independently reconciled absolute start/stop times here.

The new profiler binary was decoded as lucko/spark protobuf `SamplerData`, using the `SamplerMetadata`, `WindowStatistics`, and `Metrics` fields. The report's two 60-second windows are preferred over graph metrics with a rolling history that begins before profiling started.

## Measured SMP results (new run)

- Spark capture: **2026-10-09 23:43:47.265–23:45:47.563 UTC** (19:43:47–19:45:47 EDT), **120.298 seconds**, **2,406 ticks**, Paper 26.2-129-9240f58, 32 reported logical CPUs.
- Players: **11–12** within the recording (12 in both one-minute window summaries).
- One-minute TPS values: **19.99999993** and **20.00000017**. No sustained TPS drop in these windows.
- First one-minute window: median tick **17.774 ms**, largest tick **206.136 ms**, mean JVM process/system CPU fractions **0.03254 / 0.03763**.
- Second one-minute window: median tick **17.137 ms**, largest tick **94.914 ms**, mean JVM process/system CPU fractions **0.03002 / 0.03708**.
- Spark's last-one-minute MSPT snapshot: mean **18.973 ms**, median **17.131 ms**, p95 **30.713 ms**, maximum **94.914 ms**.
- Spark's last-five-minute MSPT snapshot, **not confined to this capture**, had mean **26.574 ms** and p95 **52.890 ms**. Do not treat those five-minute readings as two-minute experiment results.
- The rolling MSPT-series first sample showed a 243.601 ms maximum carried into the recording from its preceding rolling window. The largest **within-capture** tick in the one-minute WindowStatistics was **206.136 ms**.
- CPU: latest one-minute JVM process reading ~**3.00%** and system reading ~**3.71%** in spark's normalized reported format. The series during capture showed about 2.1–4.4% process and 2.8–6.7% system. These metrics do not isolate llama.cpp on the other Bloom split.
- JVM heap: **17.578 GiB** committed/max, sampled used **6.37–16.30 GiB** within capture; minor ZGC activity observed (9 cycles within the profile's platform stats). This is no evidence of SMP OOM, but heap occupancy and GC should be watched.
- Reported physical host memory snapshot: ~**36.0 GiB used of 187.8 GiB**; swap snapshot ~**3.15 GiB used of 98.8 GiB**. A snapshot cannot establish instantaneous free memory during AI inference or prove swap pressure.
- No direct separate native AI CPU-stack, container IO, or explicit benchmark start/stop markers appear in this SMP profile.

## Against pre-AI baseline

| Metric | Pre-AI baseline | New SMP capture |
|---|---:|---:|
| Duration | ~180.6 s | 120.3 s |
| Players | 0–4 | 11–12 |
| TPS | ~20 | ~20 |
| Last-minute mean MSPT | 9.385 ms | 18.973 ms |
| Last-minute p95 MSPT | 14.640 ms | 30.713 ms |
| Last-minute MSPT max | 82.550 ms | 94.914 ms |
| Largest captured isolated tick | ~826.9 ms | 206.136 ms |
| JVM/system CPU apples-to-apples comparison | Not captured in baseline document | ~3.00% / ~3.71% last minute |

**Interpretation:** The latest SMP sustained the target 20 TPS with ~12 players. MSPT approximately doubled versus the low-population baseline, but player load also increased roughly 3–12x and may explain much of the increased tick cost. This is **not proof that AI caused slowdown**, nor proof that AI and SMP will coexist safely under peak player load. Occasional ticks above 50 ms could still cause visible jitter.

**Confidence / caveats:** The new spark recording is **120 seconds**, not the intended 180; the serial Qwen test ran **151.4 seconds**. Without recorded AI inference start/end timestamps, exact overlap is not independently established from the artifacts. A second recording with comparable player load, precise timestamps, and independent AI container CPU/RAM metrics is needed for causal attribution.

## Operational decision

- **Provisional GO for further isolated/staging development at current 4 model threads, one inference request at a time and controlled load.**
- **NOT a GO for live Discord rollout, automatic CPU thread/concurrency increases, production SMP modification, merging draft #118, or sustained peak-load certification.**
- Do not start another stress test solely because of this report. Keep one-shot AI scripts from auto-restarting on successful exit.
- Next planned performance validation (only when warranted and authorized): record synchronized timestamps and both split metrics, compare against a similar-player-count AI-off interval, and observe busy-hour load.
- Prioritize source-grounded factual retrieval, staged Agent/Gateway/Discord composition, and reviewed training data while maintaining the existing CPU cap.
