# Qwen3 1.7B real inference + resource test on spare Bloom Node egg

**Owner-approved target only:** Bloom server `2E4CEE8C`, `node.js generic` / Node 24, 5 GB Pterodactyl memory allocation, 8-core CPU *quota*, and 7–8 GB advertised disk storage (verify current panel after owner cleanup).

**Not a deployment.** No Discord login, no Minecraft/SFTP, no tickets, no MySQL, no OpenAI, no production endpoints and no external ports. This is a single diagnostic attempt on the **spare** server.

## Verified model source

- Model: [ggml-org Qwen3 1.7B Q4_K_M GGUF](https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/blob/daeb8e2d528a760970442092f6bf1e55c3b659eb/Qwen3-1.7B-Q4_K_M.gguf) (Apache 2.0)
- Exact pinned revision: `daeb8e2d528a760970442092f6bf1e55c3b659eb`
- Verified official model SHA-256: `d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5`
- Approximate artifact size: 1.28 GB (decimal).
- Direct model URL (the script retrieves it automatically; owner need NOT download separately unless the host's outbound HTTPS is blocked):
  `https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/daeb8e2d528a760970442092f6bf1e55c3b659eb/Qwen3-1.7B-Q4_K_M.gguf?download=true`

## Owner step: one tiny JavaScript upload

The Phase 2 `llama-server --help` test **already PASSED** on this exact spare Bloom node.js egg, and these two verified files are already there:

- `llama-server` (~18.6 MB executable)
- `llama-server.sha256` (companion SHA-256 manifest).

Keep both exactly as they are.

1. Open the spare Bloom `2E4CEE8C` **Files** tab. **Rename the older `check-bin.js` to `check-bin.old.txt` or delete it**. VERY IMPORTANT: this Node egg's startup command uses a shell `*.js` pattern in the same directory; **multiple root `.js` files cause an invalid startup condition** before Node runs. Do not leave two root `.js` files.
2. Download [`bloom-1b.js`](bloom-1b.js) and upload it to the root Files folder. Keep that exact name; MAIN FILE length is under 16 characters. Do NOT upload the repository's `deploy/bloom/package.json` to the Bloom root.
3. In **Startup → MAIN FILE**, enter only `bloom-1b.js`. Ensure the prefilled Startup Command preview compares to a single `bloom-1b.js`, not `bloom-1b.js check-bin.js`.
4. Start the spare test service and watch Console. The script will download 1.28 GB to `models/Qwen3-1.7B-Q4_K_M.gguf`, print periodic download progress, verify the exact SHA-256 and the existing `llama-server` binary, load the model under conservative restrictions, ask one benign Minecraft question, stop the native process, and print JSON with `status`, `responseSeconds`, `loadSeconds`, and `peakMemoryMiB`. Also saves only a small `bloom-1b-report.json` in the spare service root.
5. Send Console output starting with `[qwen-test] RESULT` (or the `bloom-1b-report.json` contents), **plus** the current Bloom memory/CPU panels if available. Successful one-shot exit code 0 may be mislabeled *crashed/offline* by Pterodactyl; this is expected.

**Never put credentials into either script or model files.** If the model download fails, leave existing verified artifacts untouched. Report the named failure category; the model may alternatively be downloaded via Bloom's File Manager with the exact approved URL, then moved into the `models` directory under the exact filename shown above. Only same official SHA is allowed.

## Safety limits

- CPU only: **2 worker threads**, 2 batch threads, no GPU; 2,048 tokens context, a single request and 64 maximum generated tokens.
- Binds inference **only** to a randomly selected `127.0.0.1` port; never to the public Bloom allocation.
- Reads actual **cgroup memory limit/current**. Refuses to test if that limit is missing or not between 3 and 6 billion bytes, and aborts the model process if memory usage exceeds **90%** of the observed cap. Host physical memory is ignored.
- Model download is streamed to a temporary file (not held in RAM), bounded to 1.5 GB, and the **full 64-digit trusted SHA-256** must match before model execution. Interrupted temporary downloads are cleaned up.
- `llama-server` binary is re-verified against `llama-server.sha256` before running. All subprocesses are spawned **without a shell**; errors shut down the native child.
- Timeout bounds: 45 minutes for model download, 180 seconds for model loading, 120 seconds for a single inference request.
- Does not leave a listening AI server running. Memory and latency results are **observations only**, not a guarantee for concurrent Discord production use.

## What success unlocks

Only if it loads successfully, RAM stays well below the 5 GB limit, and response times are usable: Stage the existing Agent/Gateway/knowledge components as a separate test on this **same** Bloom service, one service under a single supervisor, and later wire up the verified data store. Existing knowledge indexer uses **SQLite**, so there is still no need to create MySQL yet. Do not start a second live Discord session using the same token or merge draft PR #118 without the owner's separate permission.
