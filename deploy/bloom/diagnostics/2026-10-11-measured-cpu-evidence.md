# October 11, 2026 — Bloom AI co-location per-thread CPU evidence

**Read-only analysis; no live deployment or restart performed.** Evidence: owner-provided original AI JSONL `bloom-cpu-evidence-2026-10-11T20-15-24-752Z.jsonl`, original SMP Spark protobuf [hizt2rurZb](https://spark.lucko.me/hizt2rurZb), AI console, aborted benchmark report. Record is 58 samples over 56.8 seconds (2026-10-11 20:15:24.754–20:16:21.510 UTC).

## Observed results

| Measure | Observation |
|---|---|
| AI four-thread inference | ~400.0% CPU (four logical-CPU equivalents) for 40 high-utilization 1-second samples |
| Host-visible per-core sum during sustained generation (20:15:42–20:16:20 UTC) | **704% mean, 959% max** of 3,200% total capacity; ~22% average, 30% peak |
| AI cgroup throttling | **0 throttled periods; 0ms throttled** in entire capture |
| AI cgroup memory | Peak **13,907.5 MiB** (13.58 GiB) vs ~44.7 GiB memory hard limit; OOM events **0** |
| AI cgroup CPU pressure (PSI some) | ~8.91ms over 39 inference samples |
| Host-visible CPU PSI some | ~90.03ms over 39 inference samples (not a substitute for Minecraft per-thread latency) |
| Native `llama-server` four busy threads | TIDs 37, 74, 75, 76: **155,778ms combined CPU execution** vs **~93ms cumulative scheduler wait** across their overlapping lifetimes |
| Most-used host-visible logical CPUs while generating | CPU21 ~90.8%, CPU23 ~78.6%, CPU6 ~60.2%, CPU20 ~52.3% mean; others lower |
| AI CPU allowed placement | All CPUs 0–31; **not pinned**; sampling shows migration across multiple processors |
| Swap | Not measured (null in sampler); do not infer zero |

### Correlated Minecraft effect

AI monitor began **20:15:24.753 UTC**; sustained four-thread inference first observed ~**20:15:42 UTC**. Owner manually stopped AI **20:16:21.509 UTC**, after 14 requests. The resulting `fetch failed` benchmark result is consistent with interruption and not proven independent crash.

Spark 11-second sampled TPS:
- **20:15:15:** 20.00
- **20:15:47:** 16.54
- **20:15:58:** 11.36
- **20:16:08:** 11.19
- **20:16:19:** **10.61**
- **20:16:29:** 18.56 (AI stopped 8 sec earlier)
- **20:16:39:** 19.77
- **20:16:50:** 20.00

Spark one-minute average TPS: **16.813**, **16.673**, then **20.000 / 20.000 / 20.000**, 25–27 players. Rolling Spark tick-duration p95 rose from ~49ms before model startup to **121.7ms at 20:16:24** (remember rolling period).

## Interpretation

The AI model was receiving nearly all its requested logical-CPU service; no AI CPU quota throttling, no observed AI OOM or material AI native-thread scheduling wait. Meanwhile Minecraft tick throughput fell sharply, correlating with the workload and recovering soon after stopping it. This further corroborates the suspected **shared-host interference** at far less than total aggregate CPU capacity. It does **not** prove *why*: Minecraft Java main-thread scheduling wait or physical-core placement wasn't captured; other hypotheses include physical/SMT core competition, dynamic CPU frequency, last-level cache, memory bandwidth, and SMP workload differences. AI `lastCpu` is the last sampled CPU, not a residency trace. `/proc/stat` per-core usage covers the host-visible aggregate (including other services), not just AI.

**No extra prolonged CPU test is justified solely to reproduce the TPS failure.** To determine mechanism, need synchronized SMP Java server-thread native TID, per-thread runqueue wait/scheduling delay, cgroup cpuset/pressure/throttling, host `mpstat -P ALL` and `pidstat -t` or similar, physical SMT grouping, CPU frequency/thermal readings and I/O across model hash/load. These generally require host-level or SMP process access, likely Bloom assistance; do not arbitrarily pin cores without measuring both sides.

Current diagnostic script is isolated on the unmerged `diagnostics/bloom-per-thread-telemetry-20261011` branch, not a deployment candidate. Nothing here changes live servers.

## Evidence links

- [Current SMP Spark capture](https://spark.lucko.me/hizt2rurZb)
- [Previous AI-off SMP Spark](https://spark.lucko.me/XfV2Ng3iUY)
- [Prior AI inference SMP Spark](https://spark.lucko.me/KVq6dhxfP0)
- [Issue #119 — shared-host investigation](https://github.com/wsg138/Enthusia-AI/issues/119)
