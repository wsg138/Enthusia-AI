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
