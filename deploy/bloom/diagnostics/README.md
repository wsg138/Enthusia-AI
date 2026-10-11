# Bloom AI per-thread CPU monitor (test-only)

This folder is a **diagnostic branch** and not installed into production. Do not merge or deploy this alongside Enthusia AI production services.

## Use on the AI Testing / Temp Server ONLY (CC19EA3C)

1. Stop the AI split. Confirm the current `bloom-30b.js` is the *cached-only* `[qwen-loadtest]` script (not `cpu-probe.js` or a downloader).
2. Rename existing root `bloom-30b.js` to `bloom-30b-bench.cjs`. Preserve the GGUF, `llama-server`, checksum, server marker and reports.
3. Bloom Files → **Download from URL** using the raw URL pinned at commit `82f0cb59967390b9f820354b606711b8ad0d2b6c` below. It must arrive as the only root `bloom-30b.js`. Startup `MAIN_FILE` remains `bloom-30b.js`.
4. If the Bloom Startup page exposes `ENTHUSIA_BLOOM_INFERENCE_RUN_APPROVED`, set it to `1` only for the test, then reset it afterward. If it does not expose that variable, create a root text file named `bloom-cpu-one-run-approval.txt` containing exactly `APPROVE ONE ENTHUSIA AI TEST CC19EA3C YYYY-MM-DD`, replacing `YYYY-MM-DD` with the current **UTC** date. The monitor renames this marker to a consumed receipt before a single benchmark run, sets the required environment approval for the child only, and will not re-run on an automatic restart without a fresh marker. It is NOT an idle server. Run only while supervising SMP; no SMP restart or CPU pinning.
5. First start an SMP Spark profile, e.g. `/spark profiler start --timeout 300 --thread * --interval 10`. Then start AI. Stop **AI only** if SMP performance degrades materially.
6. After stopping AI, retrieve `bloom-cpu-evidence-<UTC>.jsonl` in Bloom Files and send it along with AI logs, Spark link and player counts. Do not publish unreviewed raw console logs or any secrets.

## Raw file download URL

https://raw.githubusercontent.com/wsg138/Enthusia-AI/82f0cb59967390b9f820354b606711b8ad0d2b6c/deploy/bloom/diagnostics/bloom-30b.js

## Measures

1 Hz host-visible per-logical-CPU activity, AI cgroup usage/throttle/CPU PSI, memory/swap, visible `llama-server` per-thread run/wait/sampled last CPU. At most 1200 samples. Data saved to local JSONL, with UTC timestamps.

**Limitations:** CPU numbers from `/proc/stat` are not automatically exclusive to AI or SMP; sampled last CPU is not residence time; `schedstat` may be disabled. AI PID namespace may not expose SMP Java. Host-level SMP Java per-thread scheduling measurement remains unavailable without Bloom or approved SMP diagnostics.

Local node syntax, ordinary completion, native child-detection and stop tests were run. Native Qwen model startup and remote Pterodactyl handling remain unverified. The one-time marker authorization path has been source-reviewed; it needs actual Bloom acceptance.
