# Owner handoff: convert CC19EA3C to an isolated 30B model testing server

**Status (2026-10-09): PREPARED, NOT DEPLOYED.**

The owner is retiring/wiping the *currently running* `SMP Temp` Minecraft server ID `CC19EA3C`. As last reported, Bloom shows 118 GB RAM, 3200% CPU allocation, and 50 GB disk allocation, with 36.51 GB RAM and 12.24 GB disk **still in use**. Those current values do NOT authorize a wipe or stopping it. **Do not change this server until the owner explicitly confirms that backups/migration are complete, the old SMP Temp is shut down and wiped, and it is now available for Enthusia AI staging.**

## Prepared offline

- Diagnostic script: [`deploy/bloom/bloom-30b.js`](bloom-30b.js). **Do not start before wipe confirmation.**
- Source: `second-state/Qwen3-30B-A3B-Instruct-2507-GGUF` Q4_K_M, exact path `Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf`.
- Official file page: https://huggingface.co/second-state/Qwen3-30B-A3B-Instruct-2507-GGUF/blob/main/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf
- Exact published SHA-256: `0155f4523b0c2e3cb541abdc4b5b1845e7b74af9ae8ae8dde9f4d09783371c86`; size roughly **18.6 GB**. The download link uses `main`, but checksum validation makes any changed artifact fail closed before model execution.
- Starts native pinned `llama-server` ONLY after verifying an already vetted `llama-server.sha256`. The old separate spare Bloom `2E4CEE8C` has a passing native runtime diagnostic; transferring its two tested binary files to the new **wiped** spare is acceptable if the owner approves, but this project does not access that server or secrets.
- Node 24 generic egg and root `MAIN FILE = bloom-30b.js`; only a single root `.js` file (important known Pterodactyl template expansion bug).
- Compares 15 precisely identical prompts with the earlier 1.7B baseline (that model failed seven of nine basic vanilla Minecraft facts).
- CPU-only: eight threads, 2048 context, one parallel slot, localhost-bound random port, no Discord/SFTP/Minecraft/MySQL/production secrets. Samples actual Pterodactyl **cgroup memory**, 85% cap, 10-minute model-readiness timeout and 120-second timeout for each of 15 questions. One-shot exit code 0 is *success* even if panel labels the stopped test offline/crashed.
- Download is streamed to `models/`, hard size bound **18.0–19.5 GB**, hashed and validated before launching. An interrupted download removes the partial file. Allow for free space before starting — at least **25 GB actually free on Bloom disk** (30 GB preferable). **Never run on an un-wiped server.**
- Saves `bloom-30b-report.json` in the root with each answer, latency, tokens, observed memory, and status. Test PASS means technical execution; **human scoring of factual correctness is still mandatory**.

## AFTER the owner confirms wipe complete

1. Verify the correct panel server: **`CC19EA3C`**. Check RAM allocation and at least **25 GB free disk**. If Minecraft artifacts like `server.jar`, `world/`, `plugins/`, `versions/`, or `libraries/` remain, **STOP** — the old server may not be cleared.
2. Upload only the previously checksum-verified `llama-server` and its corresponding `llama-server.sha256` to the wiped server root. No live SMP tokens, database files, or other world data.
3. Create a root text file named exactly **`enthusia-30b-staging-ok.txt`** with contents **`CC19EA3C WIPED FOR ENTHUSIA AI`**. This is the explicit owner confirmation and test-server identity gate; the script refuses to download anything if missing or wrong.
4. In Bloom Files → **Download from URL**, paste `https://raw.githubusercontent.com/wsg138/Enthusia-AI/fix/discord-command-safe-upsert-20261008/deploy/bloom/bloom-30b.js`. Ensure saved filename exactly `bloom-30b.js`, and **no other root `.js` files**. Do not upload the repository's `deploy/bloom/package.json` to the container root.
5. Set Startup → MAIN FILE to **`bloom-30b.js`**. Start once. Initial ~18.6 GB download can take a long time; wait for GB progress logs, then model hash/load and `Q01–Q15` completion logs. Refrain from multiple manual starts if it reports FAIL. Script uses a 90-minute max download time.
6. Share **`bloom-30b-report.json`** (or entire `[qwen-30b] RESULT` Console section). Review all answers, actual latency, memory, disk, and CPU. Compare with 1.7B factual **2/9** baseline before changing any model selection or spending money.

**What remains blocked:** Full fine-tuning remains dependent on independently reviewed and admitted training records. The initial A100 80GB Qwen3 30B-A3B **2-step** real-data adapter smoke has succeeded (17 GOOD train, 3 GOOD validation), but is **not** a final training/accuracy run. The 1,301 synthetic worker candidates on issue #94 have **zero independently admitted** candidates at the last recorded checkpoint; do not train directly on them. A GPU rental or new charges require a current quote and adherence to the $25 cap. The new search tool is isolated/dev-only, off by default, and its unverified snippets are *not* proof of correctness. No automatic changes to SMP, Discord, MySQL, or host settings.
