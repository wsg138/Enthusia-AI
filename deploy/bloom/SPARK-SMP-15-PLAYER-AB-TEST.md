# SMP / Qwen3-30B — roughly 15-player matched A/B test

Prepared 2026-10-09. **Not executed yet.** This is a staged measurement, not production authorization.

## Objective and evidence
Compare SMP performance at **14–17 real online players** with **AI off** versus a second, near-adjacent measurement at similar real player activity with **AI on** using the previously tested serial four-thread 30B benchmark on the dedicated **AI-only Bloom split CC19EA3C**. Avoid synthetic players or artificial SMP load.

Earlier benchmarks:
- Pre-AI baseline https://spark.lucko.me/xZbslOOPs3: 0–4 SMP players, ~20 TPS, last-minute mean MSPT 9.385 ms, p95 14.640 ms.
- Prior AI-co-location SMP https://spark.lucko.me/CMnQiaRc47: 11–12 SMP players, ~20 TPS, last-minute mean MSPT 18.973 ms, p95 30.713 ms.
- AI load test previously completed 58 serial requests in ~151.4 s, response mean ~2.6 s, 4 threads, peak sampled ~13,965 MiB; no OOM. These earlier runs **do not** establish an apples-to-apples AI-off/AI-on comparison.

## Hard safety boundaries
- **Never stop/restart/modify the live SMP.** The sole SMP operation is spark's temporary profiling command.
- AI test split only: `CC19EA3C`; **do not** accidentally start a test on another Bloom split or on production.
- Do not increase threads above **4**, parallelism above **1**, or context above 2048. No Discord, SFTP, MySQL, production bot, or other integrations.
- Model GGUF, checksum validation, and native llama binary are already installed in the AI split. **Do not redownload or delete them**.
- AI split should be OFF before baseline. Existing one-shot load script deliberately idles after its successful workload so Bloom's auto-restart policy cannot silently repeat. Manually STOP the AI split after the workload.
- Abort the **AI split only** if SMP has repeated serious stutter, sustained TPS degradation, major out-of-memory/swap pressure, or a significant increase in MSPT concurrent with inference. Preserve evidence and notify owner; do not change SMP.
- Do not merge draft PR #118, deploy to production Discord, or rent a GPU because of this test.

## Owner/panel steps

### 0. Preflight
- Verify **14–17 real players are online and activity is representative**, preferably a few minutes at a stable count. Record approximate counts/activity during both windows.
- In Bloom, verify AI split `CC19EA3C` is **stopped**, and that its STARTUP **MAIN FILE** is `bloom-30b.js` (max 16 characters).
- The latest GitHub `deploy/bloom/bloom-30b-loadtest.js` includes exact UTC timestamps `scriptStartedAtUtc`, `scriptFinishedAtUtc`, `workloadStartedAtUtc`, `workloadFinishedAtUtc`. If the panel still has an older `bloom-30b.js`, update **only that script**, ensuring it is the sole root `*.js`, by downloading the GitHub raw script and naming it `bloom-30b.js`. Do not replace `llama-server`, GGUF, checksum file or marker.
- Preserve the automatic-idle safety after an ordinary completed benchmark.

### 1. AI OFF baseline
- On the live SMP console (spark only): `/spark profiler start --timeout 180 --thread * --interval 10`
- Leave the AI split stopped for the entire **180 seconds**.
- Save SMP spark link and, ideally, `.sparkprofile`; note approximate player count, notable events, other concurrent workload.

### 2. AI ON comparison
- If count remains near 14–17 and SMP baseline looks safe, on SMP console run:
  `/spark profiler start --timeout 240 --thread * --interval 10`
- **Immediately** start Bloom AI split `CC19EA3C` with its cached-only benchmark `bloom-30b.js`.
- Let the **150-second** serial AI workload complete, unless SMP becomes unstable. The extra 90 seconds of spark profiling allow startup/verification and some post-inference comparison.
- Save second spark link, `.sparkprofile`, AI console's `[qwen-loadtest] RESULT`, and `bloom-30b-loadtest-report.json`. Check actual workload UTC start/finish timestamps versus spark timestamps.
- Manually **STOP the AI split** after it prints `Benchmark finished; inference stopped. Idling...`; verify it stays stopped. No need to restart any other server.

## How to judge
- Both windows should have roughly comparable real player counts **and activity** (exploration/chunk generation, combat, events and plugin activity can differ).
- Confirm AI inference actually overlapped the *AI-on spark recording* by timestamps. If not, classify the test as inconclusive rather than PASS.
- Compare TPS (and whether 20 TPS is sustained), MSPT mean/median/p95/p99, time above 50 ms, isolated major spikes, JVM process/system CPU, memory/GC/swap and player count. Analyze **inside the inference-overlap window** rather than only last-minute rolling samples.
- Indicative green flags: consistent ~20 TPS, most ticks comfortably below 50 ms, no reproducible large p95/tail increase against comparable AI-off interval, no unusual host contention or OOM.
- Any sustained TPS below 20, major consistent tick tail increase or user-visible lag correlated with inference needs follow-up. One stable 15-player sample cannot establish safety at peak 30–40+ population.
- Report verdict as **staging GO**, **conditional**, or **NO GO**, with limits; only then proceed to source-grounded Minecraft/Enthusia factual retrieval and test-only Agent/Gateway composition.
