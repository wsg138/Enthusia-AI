# deploy/bloom — Bloom.host (Pterodactyl) deployment target

**W21 — prepare only. Nothing here deploys anything.** These files are
templates and documentation. Applying them to the panel is a manual,
user-approved step owned by a future deployment run.

## Files

| File | Purpose |
|------|---------|
| `egg.json` | Pterodactyl egg template: Enthusia AI split (agent, discord, inference, indexer). Import into the panel; one server per role. |
| `startup.sh` | Container startup script referenced by the egg. Validates env, sets OOM priority, applies optional CPU pinning, launches the role. |
| `resource-limits.env` | Default environment: RAM cap (24–32 GB envelope, §63), thread bounds (§35.2), OOM score (§35.4), observability ports (§36). Secrets stay empty — injected by the panel, never committed (§34.1). |

## Provisioning checklist (manual, future)

1. Import `egg.json` into the Pterodactyl panel (nests: create "Enthusia AI" nest first if needed).
2. Create one server per role (`AI_SERVICE=agent|discord|inference|indexer`), §35.1.
3. Set the panel allocation RAM/CPU to match `deploy/RESOURCE-LIMITS.md`.
4. Paste `resource-limits.env` values into each server's environment; fill secrets in the panel only. Keep `INFERENCE_BIND_HOST=127.0.0.1` unless another container must connect; in that case use a private/internal address and firewall it from public ingress.
5. Place the model artifact per `deploy/MODEL-ARTIFACTS.md`.
6. Follow `deploy/RUNBOOK.md` — startup sequence starts SMP-critical services first.

## SMP safety (non-negotiable)

- AI process failure must not stop SMP, moderation, or the Ticket Bot (§35.4).
- CPU explicitly bounded via `INFERENCE_THREADS`/`INDEXER_THREADS` (§35.2).
- Memory capped at 24–32 GB initial target (§63).
- AI starts after SMP-critical services (§35.3).

See `deploy/RUNBOOK.md`, `deploy/RESOURCE-LIMITS.md`, `deploy/MODEL-ARTIFACTS.md`, `deploy/LOGGING.md`.
