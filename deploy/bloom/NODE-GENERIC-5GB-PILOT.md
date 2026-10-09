# Bloom Node Generic — 5 GB test plan

**Status: not yet tested on Bloom.** The owner has a spare 5 GB RAM Bloom server and wants the Enthusia AI stack in ONE managed service. The screenshots show node.js generic, Python generic, C++, Red and specialized bot eggs, but **do not prove root/VPS/custom-Docker or native-executable permissions**.

## Memory budget

Published Ollama Qwen3 download sizes: https://ollama.com/library/qwen3

| Model | Weight-file size | Recommendation for a 5 GB server |
|---|---:|---|
| Qwen3 8B | 5.2 GB | Do not use: exceeds the entire RAM allocation before overhead |
| Qwen3 4B | 2.5 GB | Only test after measured free RAM, CPU and peak usage |
| Qwen3 1.7B | 1.4 GB | First model candidate, if native executable is permitted |
| Qwen3 0.6B | 523 MB | Tiny fallback for runtime/inference diagnostics |

A model needs additional RAM for working context and other processes. These are download sizes, not peak RAM measurements.

## Step 1 — no-secret capability check on the spare Bloom test server

1. Select the existing **node.js generic** egg for the spare test service, preferably with a Node 24 image **if offered**. Do not change the SMP or any existing live bot egg.
2. Upload only [probe-node-generic.mjs](probe-node-generic.mjs) into that server's root using the file manager. No secrets, source repository, model download or production server data is needed.
3. On the empty test service only, use the startup command **node probe-node-generic.mjs** if the Startup tab allows editing. Start the test server.
4. Share the generated JSON report or a screenshot of the Console. If the Startup command is locked, send a screenshot of the test service's Startup tab (hide sensitive fields).

The probe has **zero network calls**, no Discord or SFTP access, and no environment-variable dumps. It prints a small allowlisted report: Node major, Linux architecture, child-process permission, cgroup memory/CPU limits if exposed, writable workspace, and whether a harmless copy of /bin/true can run from that workspace. It cleans up a temporary test directory after itself.

The test does NOT prove data survives a restart, prove an uploaded llama-server works, connect the AI model, or authorize a live server action.

## Step 2 — decision based on report

- If Node 24, writable files, child processes and native executable launches are permitted: stage Agent/Gateway/indexer without Discord credentials first, then measure a SHA-256 verified **Qwen3 1.7B** CPU model's true memory and latency before considering Qwen3 4B. Keep panel allocation at 5 GB and tightly bound threads and context.
- If native executables are blocked: Node services may still be viable, but the local model must use another explicitly supported provider arrangement. Do not assume a custom Docker egg is importable.
- If Node version, memory exposure, or startup configuration is unsupported: use the Startup tab to design around the actual host, rather than install arbitrary system packages.

Red/Red-DiscordBot, Botify and Python generic do not replace the custom existing Node system.

**No changes are authorized for live SMP, production Discord, SFTP or ticket integrations.** All development remains on isolated draft PR #118; track in issue #119.

## Owner-confirmed spare Bloom Node egg — 2026-10-09 00:23 EDT

Owner ran the `probe.js` wrapper with `probe-node-generic.mjs` on the spare Bloom service. **This phase PASSED.** The supplied real console reported:

- Node `v24.17.0`, Linux x64, Node child processes permitted.
- Memory cgroup `4,999,999,488 bytes`, i.e., a hard cap just under **5.0 GB decimal** (approximately **4.66 GiB**). The `123.4 GiB` shown by `os.totalmem()` was the host and is NOT this container's allocation.
- CPU cgroup quota equivalent to **8 CPU cores**; this does not promise eight isolated physical cores.
- Workspace writable; a copied **harmless** native Linux executable can run.
- Docker image import rights, restart persistence, a real llama-server executable and model loading **remain untested**.
- The probe exits **code 0** by design. Pterodactyl reporting offline/"crashed" after it ends is expected, not evidence of OOM.

**Conclusion:** no full VPS or custom egg is needed to attempt the next native executable compatibility check. The normal `node.js generic` egg is viable for Node components and appears capable of executing a verified native binary. It has NOT yet demonstrated a running local AI model.

## Phase 2 — actual llama-server CLI, still no model or credentials

We now prepare a trusted *diagnostic* portable `llama-server` from the pinned upstream source commit `3d65c90d04d337e88f2b1f7f0061f40a5324e662` using the isolated GitHub Actions Linux image build. The workflow also uses an offline local **synthetic /v1/models** endpoint for Agent/Gateway startup (the earlier CI lifecycle run failed only because no inference endpoint was present in an offline container).

**Wait for the GitHub build to complete SUCCESSFULLY before the following owner steps.** In the [Bloom Linux image build Actions workflow](https://github.com/wsg138/Enthusia-AI/actions/workflows/bloom-image-verify.yml), open the latest successful run and download the artifact named `enthusia-linux-llama-bloom-diagnostic`. Extract its ZIP on the owner's computer. Its contents are a SHA-pinned `llama-server` executable, `llama-server.sha256`, `dependencies.txt` for audit and `check-bin.js`.

Upload ONLY these 3 files to the **root** of the same unused 5 GB Bloom test service:

- `check-bin.js` — safe short main file for the Node generic egg.
- `llama-server` — compiled native executable, no weights.
- `llama-server.sha256` — companion checksum from the same CI job.

Set **MAIN FILE** to `check-bin.js` (not `node check-bin.js`; the egg adds `node` itself). Start once and send its console report. The script checks file size and exact SHA-256, applies an executable flag, runs **only `llama-server --help` for up to 5 seconds** without network or any model file, and prints `PASS` or a bounded failure category. Exit code 0 after a PASS causes Pterodactyl to show offline; this is expected.

`dependencies.txt` lists system libraries used by the binary and may be useful to determine why a binary fails on Bloom. Do **not** upload it unless troubleshooting calls for it. Do not use SFTP to the live SMP or any existing bot's files.

Only after Phase 2 PASS can we consider model weights. Start with Qwen3 1.7B at conservative **1–2 CPU threads and 2048-token context**, instrument actual cgroup memory and wall-clock response time, and stop if the container nears its 5 GB memory limit. Never attempt Qwen3 8B there.
