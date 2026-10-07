# Enthusia AI — Operations Runbook (W21)

**PREPARE ONLY.** This runbook documents startup, shutdown, rollback, and
emergency procedures for a future deployment. No procedure here has been
executed; nothing is deployed. Spec: MASTER-SPECIFICATION.md §§31, 35, 36,
63, 64.

**Golden rule (non-negotiable):** AI process failure must not stop SMP,
moderation, or the Ticket Bot (§35.4). Every procedure below preserves that.

---

## 1. Pre-flight checklist

Before any start/restart/deploy of AI services:

- [ ] SMP is running and healthy (players unaffected).
- [ ] Ticket Bot is running and healthy.
- [ ] Model artifact manifest exists and hashes verify (`deploy/MODEL-ARTIFACTS.md`).
- [ ] Secrets are present in the panel/systemd env (never in the repo, §34.1).
- [ ] Resource bounds match `deploy/RESOURCE-LIMITS.md` (panel allocation or systemd unit).
- [ ] Previous known-good artifact + config are retained for rollback (§2).
- [ ] If ticket **video** evidence is being enabled, the Ticket Bot has already
      deployed the `ticket-evidence evidence-v2` contract and the agent runtime
      provides both `ffprobe` and `ffmpeg`. Verify with
      `ffprobe -version` and `ffmpeg -version`. Missing media tools do not
      block agent startup; video evidence fails closed and screenshot evidence
      remains available.

---

## 2. Startup

### 2.1 Sequencing (§35.3)

Large model startup must not coincide with SMP-critical operations.

1. Confirm SMP-critical services are up: SMP, moderation, Ticket Bot.
2. Start the **inference** role first (model warmup takes minutes).
3. Wait for the raw inference runtime's `GET http://<private-host>:8080/health` to
   return HTTP 200 with `{"status":"ok"}` before starting dependents. The template
   binds to loopback by default; cross-container access requires an explicit private
   bind address plus firewalling. Never expose raw llama.cpp directly to public ingress.
4. Start the **agent** role; wait for its `/health/ready` → `ok`.
5. Start **discord** and **indexer** roles last (indexer is low-priority background, §63).

Never start AI roles before SMP-critical services on a shared host.

### 2.2 Bloom.host (Pterodactyl)

1. In the panel, verify each AI server's allocation matches `deploy/RESOURCE-LIMITS.md`.
2. Verify environment variables (secrets filled in the panel only).
3. Start servers in the §2.1 order. Check raw llama.cpp with `/health`;
   check Enthusia Node services with `/health/ready`.

### 2.3 systemd (local/bare metal)

```bash
systemctl start enthusia-ai-inference.service
# llama.cpp reports 503 while loading and 200 when the model is ready
curl -fsS http://localhost:8080/health
systemctl start enthusia-ai-agent.service
curl -s http://localhost:8080/health/ready
```

Units are health-gated. The raw inference unit polls llama.cpp `/health`;
Enthusia Node services use the shared `/health/ready` contract. A unit that
never becomes ready fails to start rather than running degraded silently.

### 2.4 Verification after startup

- Raw llama.cpp: `GET :8080/health` → HTTP 200 with `{"status":"ok"}`.
- Raw llama.cpp: `GET :8080/metrics` → Prometheus exposition when `--metrics` is enabled.
- Enthusia Node services: `GET /health/live` and `GET /health/ready` use the shared §36 contract.
- The inference adapter derives `modelLoaded` from `/v1/models`; it is not a llama.cpp `/health` field.
- Structured logs show startup version and dependency status (§36).

---

## 3. Shutdown

### 3.1 Order

Reverse of startup: indexer → discord → agent → inference. SMP, moderation,
and Ticket Bot are **never** stopped as part of an AI shutdown.

### 3.2 Graceful shutdown

1. Stop accepting new work (agent: drain queue; inference: finish in-flight requests).
2. `systemctl stop enthusia-ai-inference.service` (or stop the panel server).
3. llama.cpp `--mlock` memory releases on exit; verify with raw `/health` failing (process gone) and host memory returning to baseline.
4. Confirm SMP/Ticket Bot unaffected.

### 3.3 Shutdown timeouts

- Agent: 30 s drain, then SIGKILL.
- Inference: 120 s drain (in-flight generations), then SIGKILL.
- Indexer: 60 s (checkpoint index progress), then SIGKILL.

---

## 4. Rollback

Every deployment records: repository, commit, build artifact, target server,
deployment time, current runtime version (§31). Rollback restores the previous
known-good triple: **artifact + config + model manifest**.

### 4.1 Procedure

1. Stop the AI role(s) being rolled back (§3). Do not touch SMP/Ticket Bot.
2. Restore the previous artifact (CI build pinned by commit SHA) and its config.
3. Restore the previous model manifest entry if the model changed
   (`deploy/MODEL-ARTIFACTS.md` — artifacts are content-addressed by hash).
4. Start in §2.1 order; verify the role-appropriate health endpoint and `/metrics` as in §2.4.
5. Record the rollback: what was reverted, from SHA → to SHA, reason, time.

### 4.2 Rollback triggers

- The role-appropriate readiness check (`/health` for raw llama.cpp, `/health/ready` for Enthusia services) stays unhealthy past the startup gate.
- Crash loop (`StartLimitBurst` exhausted on systemd; repeated container exits on panel).
- Regression in evaluation or player-facing behavior traced to the new artifact.
- Resource breach: model RAM above the 32 GB envelope, CPU saturation impacting MSPT.

### 4.3 What rollback never does

- Never rolls back SMP, moderation, or Ticket Bot to fix an AI problem.
- Never deletes the failed artifact — keep it for post-mortem (§32).

---

## 5. Emergency procedures

### 5.1 AI is consuming too much CPU/RAM (SMP lagging)

1. Confirm via `/metrics` (`enthusia_model_ram_bytes`, host MSPT/tick metrics).
2. Stop the inference role immediately (panel stop or `systemctl stop`).
3. Verify SMP recovers (MSPT back to baseline).
4. Investigate: thread count misconfig (`INFERENCE_THREADS`), model too large
   for the envelope, runaway queue (`enthusia_inference_queue_depth`).
5. Do not restart until the root cause is addressed and bounds re-verified.

### 5.2 AI process OOM-killed

Expected behavior: the OOM score (`OOMScoreAdjust` / `OOM_SCORE_ADJ`) ensures
the AI dies before SMP/moderation/Ticket Bot (§35.4).

1. Confirm SMP, moderation, Ticket Bot are still healthy.
2. Read logs for the OOM event; check `enthusia_model_ram_bytes` history.
3. Restart only after confirming the model fits the 24–32 GB envelope (§63).
4. If OOM recurs, treat as a resource-breach rollback trigger (§4.2).

### 5.3 AI is producing bad/harmful output

1. Stop the agent/discord roles (leave inference running only if needed for diagnosis).
2. Preserve logs (structured, with trace IDs) for the correction loop (§32).
3. Roll back to the previous known-good artifact/config (§4).
4. File feedback per §32 (capture claim, source, correction) before re-enabling.

### 5.4 Secrets suspected compromised

1. Rotate the secret at the source (Discord, OpenAI, database).
2. Update the panel/systemd environment — never the repo (§34.1).
3. Restart affected roles (§2); verify `/health/ready`.
4. Audit logs for misuse during the exposure window (§34.5).

### 5.5 Escalation

If any emergency step is unclear or SMP itself is affected: stop all AI roles
first (they are expendable), stabilize SMP, then diagnose. Notify the server
owner before restarting AI after an SMP-impacting incident.

---

## 6. Deployment record template (§31)

```
date:        2026-..-.. ..:.. UTC
repository:  wsg138/Enthusia-AI
commit:      <sha>
artifact:    <ci build id / file hash>
target:      <panel server id / host>
role:        agent|discord|inference|indexer
model:       <manifest entry id, see MODEL-ARTIFACTS.md>
previous:    <commit sha rolled back from, if any>
deployed by: <name>
health:      /health/ready ok at <time>
notes:
```
