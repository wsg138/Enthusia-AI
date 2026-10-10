# Real Qwen3 30B-A3B inference baseline and next shared-host Spark trial

**Owner-provided evidence (2026-10-09)**: paste of `bloom-30b-report.json` emitted by actual Bloom server `CC19EA3C`. This report establishes model execution and a small manually reviewed quality baseline, not readiness to serve public Discord chats.

## Actual 30B report

| Field | Observed |
|---|---:|
| Technical status | PASS |
| Exact model GGUF size | 18,556,686,048 bytes |
| Binary/model SHA verification | Both true |
| Model launch / health readiness | 8.2 seconds |
| Questions completed | 15 / 15 |
| Average reply | 2.6 seconds |
| Longest reply | 5.4 seconds |
| Sampled peak cgroup memory | 13,930 MiB |
| cgroup memory max | 45,776 MiB |
| llama CPU threads | 4 |
| Context | 2048 tokens |
| Public/private server integrations | All off |

**Scored factual prompts** (main requested answer; supplementary errors noted):

| ID | 30B | Correct reference and nuance |
|---|---|---|
| Q01 | PASS | Ordinary creeper blasts do not generally cause fire |
| Q02 | PASS | Librarian job-site block is a lectern |
| Q03 | **FAIL** | Endermen are damaged by contact with water, contrary to output |
| Q04 | **FAIL** | Smallest cornerless Nether portal frame requires ten obsidian, not a 2x2 frame; answer also truncated due to 96-token cap |
| Q05 | PASS | Wheat breeds cows |
| Q06 | **PASS count, FAIL explanation** | Four iron blocks correct, but construction is a T-shape with carved pumpkin/jack o'lantern, not a 2x2 base |
| Q07 | PASS | Normal blaze rod drop range 0–1 (excluding enchantment modifiers) |
| Q08 | PASS | Non-Silk Touch regular stone yields cobblestone |
| Q14 | **FAIL** | Comparator recipe is 3 stone + 3 redstone torches + 1 nether quartz, not the invented redstone dust/nether wart recipe |

**Headline main-answer factual 6/9 (67%) vs 1.7B 2/9 (22%)**; unknown/privacy/safety 6/6 generally appropriate in both. Training sample contains just 15 hand-picked questions; do not generalize 67% to real traffic. The four-golem-block answer has a misleading elaboration; Q04's token cap is a contributing factor but not the sole problem.

No live SMP spark profile was taken simultaneously with this owner-provided 30B run. Therefore no claim about whether the AI slowed down the SMP can be made. Preserve prior baseline: https://spark.lucko.me/xZbslOOPs3.

## Stage 2: CPU load and Spark correlation test

A separate **cached-only** one-shot staging file `deploy/bloom/bloom-30b-loadtest.js` is now prepared. It DOES NOT download a model. It fails closed if the exact existing 30B GGUF, binary hash file, wiped server marker or cgroup limit is missing/invalid.

- Up to **150 seconds** of serial inference, or **120 requests**, whichever occurs first; same 15 fixed question types repeated. This is an artificial CPU/shared-host interference benchmark, **not** additional statistically independent accuracy evaluation.
- 4 CPU threads, one parallel slot, 2048 context, max 96 generated tokens per request, localhost-only API and no new credentials.
- Samples memory and stops if it exceeds 80% of the real 48GB container limit.
- Saves the report `bloom-30b-loadtest-report.json` with reply timing and memory. **The actual Bloom runtime automatically restarted the one-shot workload after clean exit 0.** Manually STOP the AI split immediately after a completed run and verify it stays stopped. Future stress scripts must prevent automatic replay; the "crashed" label did not indicate an application OOM.

When the live SMP is stable and the owner chooses a suitable window:

1. On AI server `CC19EA3C` only, rename existing root `bloom-30b.js` to `bloom-30b.old.txt` (or delete script file, not model/data). Keep `llama-server`, `llama-server.sha256`, existing `models/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf`, and `enthusia-30b-staging-ok.txt`. No other root `.js`.
2. Bloom Files → **Download from URL**:

   https://raw.githubusercontent.com/wsg138/Enthusia-AI/fix/discord-command-safe-upsert-20261008/deploy/bloom/bloom-30b-loadtest.js

3. **IMPORTANT: Bloom limits MAIN FILE to 16 characters.** Save or rename the downloaded load-test script to `bloom-30b.js` (12 characters) in the Bloom root and set Startup MAIN FILE to `bloom-30b.js`. (The longer GitHub source basename is not valid in the panel field.) Leave AI stopped until the synchronized profile begins.
4. On the **live SMP** run `/spark profiler start --timeout 180 --thread * --interval 10`; then immediately start `CC19EA3C`. Hash checking ~18.6 GB and model loading will precede the 150s model workload; note the approximate overlap; collect start time and report.
5. Share SMP spark report URL plus `bloom-30b-loadtest-report.json` and whether players were online. This lets us compare the baseline and concurrent CPU activity. Performance during cold download needs separate testing; this script should never trigger a download.

Stop the **AI** if SMP TPS falls or MSPT rises significantly under comparable player load. Do not stop or modify the SMP to fix an AI loadtest. The container's 3200% CPU allocation is not equivalent to dedicated cores; `--threads 4` is an application bound, not a guarantee of CPU affinity.

## Accuracy remediation

Before any player-facing deployment, add version-correct source-grounded Minecraft information, current verified Enthusia docs/data read tools, and reject unverified facts instead of phrasing plausible guesses. An internet search snippet alone is not proof. A stronger model and fine-tuning help behavior and tool selection, but cannot make every memorized fact reliable. Keep all live integrations and draft PR #118 on HOLD until proper end-to-end evidence, security, and human acceptance tests.
