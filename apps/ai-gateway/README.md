# @enthusia/ai-gateway

Stable W02 API boundary for Discord, Minecraft, Ticket Bot, and future
surfaces. Model/orchestration logic remains outside this package.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/chat` | Public/internal surface `ChatRequest -> AgentResponse` boundary |
| GET | `/health/live` | Gateway process liveness |
| GET | `/health/ready` | Downstream agent reachability |

## Downstream agent

Development/tests may run against the deterministic `MockAgent`.

When `ENTHUSIA_AGENT_BASE_URL` is configured, the gateway registers
`HttpAgent` and forwards requests to the W12 agent service at
`POST /v1/agent/chat`.

The gateway always replaces the forwarded request's visibility ceiling with
the effective ceiling it already authorized. It also propagates the trace ID.

Production fails closed unless all of these are configured:

- `ENTHUSIA_GATEWAY_API_KEYS`
- `ENTHUSIA_AGENT_BASE_URL`
- `ENTHUSIA_AGENT_API_KEY`

The downstream service key is never included in redacted startup config.

## Request pipeline

1. resolve/propagate trace ID;
2. bound body size and parse `ChatRequest`;
3. authenticate the calling surface;
4. validate surface and actor type;
5. enforce the actor's maximum visibility ceiling;
6. enforce message size and rate limits;
7. route to the configured downstream agent;
8. bound the downstream call by `ENTHUSIA_GATEWAY_AGENT_TIMEOUT_MS`;
9. validate the returned `AgentResponse`;
10. return the response with the same trace ID.

## Run

```sh
npm run build -w @enthusia/ai-gateway
npm start -w @enthusia/ai-gateway
```

For a real local stack, start `@enthusia/agent-service` and set
`ENTHUSIA_AGENT_BASE_URL`. Without that variable, non-production runs use
the mock and emit a warning.

## Boundaries

- no model-specific logic;
- no direct tool execution;
- no persistent memory semantics;
- no fallback to the mock in production;
- no production deployment is performed by repository code changes.
