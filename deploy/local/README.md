# deploy/local — local development deployment target

**W21 — prepare only. Nothing here deploys anything.**

## Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Local dev services: postgres 16 + qdrant. Well-known dev-only credentials; never production secrets (§76). |
| `systemd/enthusia-ai-agent.service` | Template systemd unit for the agent service: 8 GB cap, 200% CPU, health-gated startup, crash-loop guard. |
| `systemd/enthusia-ai-inference.service` | Template systemd unit for llama.cpp inference: 32 GB cap, 800% CPU (8 threads), CPU-affinity pinning point, readiness gate on raw llama.cpp `/health` after model load. |

## Local dev

```bash
docker compose up -d postgres qdrant
DATABASE_URL=postgres://enthusiasm:enthusiasm-dev@localhost:5432/enthusiasm \
  QDRANT_URL=http://localhost:6333 npm test
```

## SMP safety in the templates

- Units carry `OOMScoreAdjust` so AI dies before SMP-critical processes (§35.4).
- Inference has an explicit thread count and a commented `CPUAffinity` pin (§35.2).
- Startup is sequenced after SMP-critical units (§35.3) — adjust the `After=`
  lines to the host's real SMP unit names when installing.

See `deploy/RUNBOOK.md` and `deploy/RESOURCE-LIMITS.md`.
