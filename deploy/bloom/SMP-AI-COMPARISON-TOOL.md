# SMP / Enthusia AI co-location evidence — post-LoreItems study

Status: **analysis tooling only**, not production authorization.

The earlier 13–14-player Qwen3-30B four-thread experiment failed the shared-host performance gate, but the Spark stack sample also identified LoreItems shulker/template scans and heavier entity/chunk ticks. No conclusion about CPU causality can be drawn until the LoreItems optimizations are deployed and verified. Prior reports: SPARK-SMP-15-PLAYER-RESULTS-20261010.md and SPARK-SMP-STACK-ROOT-CAUSE-REVIEW-20261010.md (issue #119).

## Authorized test design (not yet scheduled or run)

1. After the normal SMP restart, confirm exact **remote LoreItems active JAR SHA**, Paper build, SQLite and identity/tracking health. Do not confuse merged source with loaded binary.
2. Acquire a fresh stable **AI stopped** baseline. Only after owner/provider risk review, compare **AI stopped**, **AI model loaded but idle**, **bounded serial inference**, and **AI stopped/recovery**.
3. Record exact UTC phase start/end. Separate model file hashing/startup disk activity from sustained inference.
4. Match SMP player count, loaded chunks, container/hopper and entity workload, other co-hosted processes, server build and LoreItems SHA. Do not equate equal player counts with equivalent workloads.
5. Capture Spark profiles, TPS and per-window MSPT p50/p95/p99, plus independent CPU affinity/throttling, RAM/swap/major faults, disk IO and CPU usage of both containers. Spark only samples the SMP JVM, **not** native llama.cpp.
6. Stop **only the AI workload** on material SMP degradation. No implicit SMP restart, automatic repeat, CPU pinning changes, production AI rollout, or GPU spending.

## Offline comparison utility

Node 22+ with no npm dependencies or network/credential requirements:

    node deploy/bloom/smp-colocation-compare.mjs normalized-spark-windows.json

The JSON is a **manually verified** normalized export of real Spark 45–180 second windows and the actual inference workload UTC timestamps. This utility does NOT parse raw Spark protobuf files; always preserve the original .sparkprofile and verify extracted metrics independently.

Example input *shape* with one deliberately incomplete synthetic window (not a result):

~~~json
{
  "schemaVersion": 1,
  "workload": {
    "startUtc": "2026-10-10T00:04:00.000Z",
    "endUtc": "2026-10-10T00:06:00.000Z",
    "threads": 2
  },
  "windows": [
    {
      "phase": "off",
      "startUtc": "2026-10-10T00:00:00.000Z",
      "endUtc": "2026-10-10T00:01:00.000Z",
      "loreItemsSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "smpBuild": "Paper 26.2",
      "activityLabel": "matched-survival",
      "players": 14,
      "loadedChunks": 3000,
      "tps": 20,
      "msptP50": 15,
      "msptP95": 32,
      "msptP99": 60
    }
  ]
}
~~~

Phases: off, idle, inference, recovery. Provide **at least two OFF and two INFERENCE windows** with a real 80% or greater timed overlap of each INFERENCE window with actual model activity; add IDLE and RECOVERY when available. Include recorded player/activity and loaded-chunk observations, not guesses. Input phases may not overlap in time.

Missing p95/p99 must be omitted, never replaced with zero or estimated from p50. A missing p95 blocks the checker from declaring no clear regression. Version/build mismatch, significantly different load and inadequate overlap also prevent clearance.

Outputs are deliberately conservative:
- **OBSERVED_REGRESSION_WITH_CONFOUNDERS:** performance degraded during plausibly overlapping inference; not proven AI causality.
- **NO_CLEAR_REGRESSION_IN_MATCHED_WINDOWS:** this restricted dataset did not exceed the checker thresholds; never equivalent to safe production co-location.
- **INCONCLUSIVE:** source/timing/workload/statistical evidence insufficient.

MSPT summaries are **medians of per-window percentiles, not pooled tick percentiles**. They cannot be treated as a single raw p95/p99 distribution. Large tick samples, inclusive stacked Spark timings and rolling-five-minute history must be reviewed separately.

## Remaining gates

- [ ] LoreItems reviewed release chosen; current remote hash and WAL-consistent SQLite backup verified
- [ ] Candidate staged through approved SFTP; normal restart loads it; item security/tracking healthy
- [ ] Bloom confirms SMP and AI physical CPU topology/affinity and any full-core isolation feasibility
- [ ] Owner approves representative benchmarking window and abort criteria
- [ ] Fresh OFF/IDLE/INFERENCE/RECOVERY measurements, aligned across both containers
- [ ] Repeatable results and explicit uncertainty report; no model deployment based only on one quiet-period sample

Related work: Enthusia-AI issue #119; LoreItems PR #59 and issues #39/#54; Blackboard PR #101.
