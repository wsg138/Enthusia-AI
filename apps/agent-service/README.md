# @enthusia/agent-service

Production composition root for the W12 agent orchestrator.

This service is deliberately separate from the W02 AI Gateway:

```
surface -> AI Gateway -> agent-service -> AgentOrchestrator
                                  |-> local inference
                                  |-> registered typed tools
```

## Endpoints

- `POST /v1/agent/chat` — authenticated internal `ChatRequest -> AgentResponse`.
- `GET /health/live` — process liveness.
- `GET /health/ready` — local-inference readiness plus tool-registry status.
- `GET /v1/capabilities` — authenticated list of tools actually registered.

## Local reasoner boundary

`InferenceReasoner` is the production W03 -> W12 adapter.

The local model may propose:

- intent classification;
- evidence plans;
- bounded next tool calls.

Every response must be strict validated JSON. Unknown fields and malformed JSON
fail safely. The model does not write factual answer prose in this phase:
`draftResponse` returns an empty framing object and W12 assembles facts only
from verified evidence.

## Tool registration

The registry starts empty. Tools exist only when the composition root
explicitly configures them.

Current production-capable optional registration:

- W09 live SFTP/current-state tools through
  `ENTHUSIA_AGENT_SFTP_CONFIG_PATH`.

The path must point to the strict JSON form accepted by
`@enthusia/integration-sftp compileConfig`. Credentials are not present in
that file. Each configured `authRef` names a runtime environment variable.

For `authSource=env`, the referenced environment value is a JSON object with
runtime-only authentication material, for example a private-key field or a
password field. Do not store that value in the repository, prompts, logs,
retrieval, memory, or training data.

Unsupported or missing credential sources fail closed.

Database, player-identity, and TicketBot tools are not falsely registered just
because their library contracts exist. Their production backends/capabilities
must be configured and reviewed before they are added here.

## Service authentication

Development/tests may omit `ENTHUSIA_AGENT_API_KEYS` and receive a warning.
Production requires at least one key.

The AI Gateway uses:

- `ENTHUSIA_AGENT_BASE_URL`
- `ENTHUSIA_AGENT_API_KEY`

to reach this service.

## Run

```sh
npm run build -w @enthusia/agent-service
npm start -w @enthusia/agent-service
```

No production deployment is performed by this repository change.
