# Live SMP pre-AI spark baseline (2026-10-09)

Owner supplied profiler viewer https://spark.lucko.me/xZbslOOPs3 and its .sparkprofile binary. Parsed with the documented public lucko/spark SamplerData / WindowStatistics / Metrics protobuf schema. This is a **baseline before 30B AI inference**, not a loaded-player stress test.

## Measured observations

| Measurement | Result |
|---|---|
| Window | 2026-10-09 21:46:33.980–21:49:34.552 UTC (~180.6 seconds) |
| Server | Paper 26.2-129-9240f58 |
| Player count | Fine-grained spark series varied **0 to 4**; three one-minute summaries reported 4 |
| Three one-minute TPS windows | 19.99997, 20.00001, 20.00000 (roughly) |
| Rolling last-minute MSPT mean | 9.385 ms |
| Rolling last-minute MSPT p95 | 14.640 ms |
| Rolling last-minute maximum | 82.550 ms |
| 75 finer metric buckets | Mean MSPT ~6.89 ms; mean of bucket p95 ~13.21 ms, highest bucket p95 ~26.68 ms |
| Isolated largest tick across buckets | ~826.90 ms (already present before AI) |
| Host logical CPUs | 32 (spark-reported) |

A few spikes alone do not establish that AI causes SMP lag. Player load during capture was variable (0–4), not controlled.

## Next profiling phase

Once the 30B model is fully downloaded and verified on the owner-confirmed wiped **AI-only Bloom split CC19EA3C**, run a new spark profile on the **LIVE SMP** and restart the warmed AI QA script during its window. Same SMP command as baseline:

    /spark profiler start --timeout 180 --thread * --interval 10

Align exact [qwen-30b] model-load, first-question, last-question and shutdown timestamps with the spark time window. Separate the initial ~18.6 GB model download/checksum disk activity from ongoing inference. Compare player count, TPS, MSPT tails, process/system CPU, RAM/swap/disk pressure, garbage-collection pauses. Abort AI only for reproducible impacts; do not stop the SMP. Repeat under more representative player load before any production release.

## Install package (ready, still not run)

Read-only GitHub Actions staging artifact at https://github.com/wsg138/Enthusia-AI/actions/runs/37996258008 named **enthusia-bloom-30b-node25-staging**, validated with Node 25 and matching SHA-256 of the previously Bloom-tested 18,603,616-byte llama-server. It bundles bloom-30b.js, llama-server, llama-server.sha256, plus an optional checksum manifest. Upload those first three files to the *wiped AI server root only*.

Owner must manually create exactly **enthusia-30b-staging-ok.txt** containing **CC19EA3C WIPED FOR ENTHUSIA AI** after confirming the former Minecraft installation is gone. Set MAIN FILE to **bloom-30b.js**, the sole root .js file. Native llama threads=4, actual cgroup RAM limit=48GB target, shutdown above 80% sampled memory, 2048 context, 15 common factual/unknown questions, localhost only. No Discord, SFTP, MySQL, live player permissions, or paid training.

No server changes, model download or production deployment have been performed by this preparation. Draft PR #118 remains on HOLD.
