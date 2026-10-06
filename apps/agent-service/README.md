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
  `ENTHUSIA_AGENT_SFTP_CONFIG_PATH`;
- W05/W11 topic-familiarity memory through `ENTHUSIA_AGENT_MEMORY_PATH`;
- W14 Ticket Bot tools through
  `ENTHUSIA_AGENT_TICKET_BOT_BASE_URL` +
  `ENTHUSIA_AGENT_TICKET_BOT_API_KEY`.

Topic familiarity registers only `player.topic_familiarity`. Its memory is
subject-bound and current-only. Raw ticket/chat text is never stored in the
familiarity value. Automatic learning records only that a verified help
interaction occurred, with bounded provenance; the first interaction remains
below the familiarity confidence threshold, while repeated verified help may
suppress repetitive background. It never auto-promotes a player to `EXPERT`.

Ticket Bot registration is fail-closed: the URL and API key must be configured
together. When configured, only `ticket.capabilities`, `ticket.get_context`,
`ticket.request_close`, and `ticket.request_escalation` are registered.
Lifecycle operations remain action requests that the Ticket Bot independently
authorizes and executes; the agent receives no direct ticket mutation primitive.
The API key remains runtime-only and is never emitted in redacted startup
configuration.

The path must point to the strict JSON form accepted by
`@enthusia/integration-sftp compileConfig`. Credentials are not present in
that file. Each configured `authRef` names a runtime environment variable.

For `authSource=env`, the referenced environment value is a JSON object with
runtime-only authentication material, for example a private-key field or a
password field. Do not store that value in the repository, prompts, logs,
retrieval, memory, or training data.

Unsupported or missing credential sources fail closed.

Database tools are not falsely registered just because their library contracts
exist. Player identity still has no general production profile backend here;
the familiarity surface is the intentionally narrow exception and reads only
its dedicated W05 memory namespace.

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
