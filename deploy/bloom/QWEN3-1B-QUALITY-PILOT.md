# Qwen3 1.7B — 15-question follow-up quality and stability pilot

**Scope:** the owner-authorized spare Bloom Pterodactyl service `2E4CEE8C` only. No SMP, Discord bot, SFTP, MySQL, external API access except the pinned model download only if missing.

## Successful live Bloom checkpoint (owner-supplied 2026-10-09 console)

The existing one-shot `bloom-1b.js` ran twice on Bloom's stock Node 24 egg. Both reported PASS and clean exit 0.

- Model: SHA-256 verified `ggml-org/Qwen3-1.7B-GGUF` Q4_K_M, **1,282,439,264 bytes**.
- Model `/health` startup: **1 second** reported each run.
- One 24-token answer: **1.0 seconds** initial run and **0.9 seconds** warm run.
- cgroup memory limit: **4,768 MiB**, not physical host RAM.
- First reported peak: **2,272 MiB**; second **981 MiB** (not a comparable cold peak, likely model file residency/page-cache differences).
- No OOM or unexpected exit. The offline state after exit code 0 is expected.
- The first answer included an ordinary-creeper factual mistake (claimed it leaves a trail of fire). **Accuracy not validated.**

## Stage 2.1 — 15 fixed prompt checks

`deploy/bloom/bloom-qa.js` is the next *diagnostic*, not production deployment. It reuses the existing verified GGUF and binary, runs **15 independent prompts** about vanilla Minecraft facts, unknown Enthusia live/private information, and safe server advice. It captures the full bounded answer text and seconds for every prompt, and one continuous sampled peak cgroup memory figure. This is an **unscored owner/AI review corpus**, not ground-truth scoring; every question must be manually reviewed for unsupported factual claims.

Steps for owner on **spare** Bloom server:

1. **Keep** `llama-server`, `llama-server.sha256` and `models/Qwen3-1.7B-Q4_K_M.gguf`. Do not remove or download the GGUF again.
2. In root Files, **rename `bloom-1b.js` to `bloom-1b.old.txt`** (or delete it). Ensure **only one root `.js` file** exists; Bloom Node egg's filename expansion otherwise makes a malformed `[[ … == fileA.js fileB.js ]]` startup expression. Former `check-bin.js` must also be gone or renamed.
3. Use Files → **Download from URL**, paste:
   `https://raw.githubusercontent.com/wsg138/Enthusia-AI/fix/discord-command-safe-upsert-20261008/deploy/bloom/bloom-qa.js`
   Save it at root as **`bloom-qa.js`**. Alternately open that URL and Ctrl+S, then upload it.
4. Set **Startup → MAIN FILE** to `bloom-qa.js`, verify preview contains only that one JS filename, and **Start** the spare server once.
5. The script should print `[qwen-qa] Model ready… running 15 independent questions`, `[qwen-qa] Q01 done…` through `Q15`, and `[qwen-qa] RESULT`. It saves the full report as **`bloom-qa-report.json`**. Share the report file or console result, including answers.
6. Do not repeatedly start it if it stalls, hits the 90% RAM safety threshold, or shows `FAIL`; send the first error.

Still CPU-only two threads, 2048-token context, one slot, temperature 0, max 96 tokens each answer, randomly chosen 127.0.0.1 port, pinned model/binary SHA-256 checks, no secrets, no production integration. Stop and cleanly exit after testing; Pterodactyl may misleadingly call that 'crashed' with **exit 0**.

**Decision gate:** examine all 15 answers. In particular reject unverified claims of current player counts, server IP, ban records or official server policies. Only after the factual baseline and memory/latency measurements are acceptable should we integrate authenticated Agent/Gateway + existing SQLite knowledge tools on the spare service. The 1.7B model must never be considered authoritative for live moderation decisions on its own. Draft PR #118 remains on HOLD; no live server deployment.
