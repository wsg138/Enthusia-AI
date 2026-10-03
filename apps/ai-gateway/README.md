# @enthusia/ai-gateway

Stable API boundary for the Enthusia AI platform (W02). Used by Discord, Minecraft, Ticket Bot, and future surfaces.

Spec: `../../docs/MASTER-SPECIFICATION.md` §§7, 18, 36, 37, 47, 48; `../../docs/WORKER-EXECUTION-PLAN.md` §5.

## Endpoints

| Method | Path           | Description                                              |
| ------ | -------------- | -------------------------------------------------------- |
| POST   | `/v1/chat`     | `ChatRequest` in → `AgentResponse` out (mock agent, W02) |
| GET    | `/health/live` | Liveness probe                                           |
| GET    | `/health/ready`| Readiness probe (downstream agent reachability)          |

## Request pipeline (`POST /v1/chat`)

1. Trace ID: `x-enthusia-trace-id` header (valid UUID) → body `traceId` → generated.
2. Body size cap (`ENTHUSIA_GATEWAY_MAX_BODY_BYTES`, default 64KB).
3. JSON parse → `chatRequestSchema` validation (400 on failure).
4. Service auth: `Authorization: Bearer <key>` against `ENTHUSIA_GATEWAY_API_KEYS`
   (401). When no keys are configured, auth is disabled with a startup warning.
5. Surface / actor-type allowlist check (403).
6. Visibility ceiling: must not exceed the actor type's grant
   (player→`PLAYER_SELF`, staff→`STAFF`, system→`SYSTEM_INTERNAL`, unknown→`PUBLIC`).
   The effective ceiling is propagated downstream (403 on violation).
7. Message size (`ENTHUSIA_GATEWAY_MAX_MESSAGE_BYTES`, default 8KB → 413).
8. Rate limits: per-user 20/min, global 200/min sliding window (429 + `Retry-After`).
9. Route → downstream agent (mock in W02) with timeout
   (`ENTHUSIA_GATEWAY_AGENT_TIMEOUT_MS`, default 30s → 504).
10. Typed `AgentResponse`; trace ID echoed in body and `x-enthusia-trace-id` header.

Every request is logged as structured JSON with its trace ID (pino via
`@enthusia/logging`). API key values are never logged.

## Configuration

Environment variables (see `.env.example`); all optional with safe defaults.

## Run

```sh
npm run build -w @enthusia/ai-gateway
npm start -w @enthusia/ai-gateway
```

## Test

```sh
npm test --workspace=@enthusia/ai-gateway   # or from repo root: npm test
```

Unit tests cover routing, auth, rate limiting, validation, and config;
integration tests boot a real HTTP server and exercise `/v1/chat` and the
health endpoints against the mock agent.

## Boundaries

- No model-specific logic (W03/W12).
- No persistent memory semantics (W05).
- In-memory rate limiting only; a distributed limiter is future work.
