# Enthusia AI — Structured Logging Configuration (W21)

Spec: MASTER-SPECIFICATION.md §36 (structured logs, request IDs, startup
version), §34.1 (secret handling), §34.5 (auditing).

---

## 1. Format

Every service logs **JSON lines** via `@enthusia/logging` (pino wrapper).
Required base fields on every line:

| Field | Source |
|-------|--------|
| `time` | ISO-8601 timestamp (pino `isoTime`) |
| `level` | trace/debug/info/warn/error/fatal |
| `name` | service/component name |
| `version` | startup version (§36) — set once at boot |
| `traceId` | per-request trace ID via `logger.withTraceId(id)` (§36 request IDs) |
| `msg` | human-readable message |

Per-request child loggers carry the trace ID so a whole investigation is
greppable as one unit.

## 2. Levels

- `trace`/`debug`: development and deep diagnostics only; never in production
  by default.
- `info`: lifecycle events — startup (with version + dependency status),
  model load/unload, config changes, deployment markers.
- `warn`: degraded states — dependency `degraded`, queue backing up, retry
  storms, stale-source blocks.
- `error`: request failures, tool failures, failed health dependencies.
- `fatal`: unrecoverable — process is exiting; triggers supervisor restart.

Default `LOG_LEVEL=info` (see `deploy/bloom/resource-limits.env`).

## 3. Secret redaction (§34.1)

Secrets live in the environment/panel — **never in logs**:

- Redact before logging: tokens, API keys, connection strings, player PII
  beyond what visibility rules allow (§17).
- The logging package must never print `process.env` wholesale.
- Audit-relevant actions (who did what, §34.5) log **identities and actions**,
  not credentials.

## 4. Routing and retention

- **Pterodactyl:** container stdout/stderr → panel console + `logs` config.
- **systemd:** stdout/stderr → journald; ship to the central log store.
- Retention: 10 GB rotation cap per host (RESOURCE-LIMITS.md §4); keep
  30 days of `info`+, 7 days of `debug` (dev only).
- Metrics endpoints expose metrics only; they do not expose recent log bodies.
  Correlate logs and metrics in the central observability store by trace ID/time window.

## 5. What "good" looks like

Startup emits exactly one `service.started` line containing version,
dependency statuses, and resource bounds — enough to reconstruct the
deployment record (§31) from logs alone.
