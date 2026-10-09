# deploy/bloom — Bloom.host (Pterodactyl) deployment target

**W21 — prepare only. Nothing here deploys anything.** These files are
templates and documentation. Applying them to the panel is a manual,
user-approved step owned by a future deployment run.

> **2026-10-08 staging update:** The owner's target is **one** Bloom Pterodactyl
> server for the complete Enthusia AI stack, not one Pterodactyl server per
> service role. The files below are the earlier multi-server W21 template and
> must **not** be imported as the final configuration. New
> [single-server staging guide](SINGLE-SERVER-STAGING.md) and
> `single-server-staging.mjs` have been added and tested with Agent + Gateway.
> A SHA-256-validated managed inference launch path and an **unbuilt** Node 24 +
> llama.cpp staging Dockerfile now exist. Actual model/host validation, the
> persistent indexer, importable single-server egg and owner-approved live
> SFTP are not yet completed or deployed.
>
> See [issue #119](https://github.com/wsg138/Enthusia-AI/issues/119).

## Files

| File | Purpose |
|------|---------|
| `egg.json` | Pterodactyl egg template: Enthusia AI split (gateway, agent, discord, inference, indexer). Import into the panel; one server per role. |
| `startup.sh` | Container startup script referenced by the egg. Validates env, sets OOM priority, applies optional CPU pinning, launches the role. |
| `resource-limits.env` | Default environment: RAM cap (24–32 GB envelope, §63), thread bounds (§35.2), OOM score (§35.4), observability ports (§36). Secrets stay empty — injected by the panel, never committed (§34.1). |

## Provisioning checklist (manual, future)

1. Import `egg.json` into the Pterodactyl panel (nests: create "Enthusia AI" nest first if needed).
2. Create one server per role (`AI_SERVICE=gateway|agent|discord|inference|indexer`), §35.1. The gateway is the stable surface API; the agent is the W12 orchestration/runtime service behind it.
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
