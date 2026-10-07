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
- `POST /v1/ticket/evidence-review` — authenticated bounded ticket visual-evidence review when the Ticket Bot/policy integration is configured.

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
- W05 current structured memory and W11 topic familiarity through
  `ENTHUSIA_AGENT_MEMORY_PATH`;
- W14 Ticket Bot tools through
  `ENTHUSIA_AGENT_TICKET_BOT_BASE_URL` +
  `ENTHUSIA_AGENT_TICKET_BOT_API_KEY`;
- staff-only privacy-minimized moderation history through the authoritative
  EnthusiaStaff read API plus AI-Moderation-API support-context contract.

Memory configuration registers two bounded reads:

- `player.topic_familiarity` — subject-bound, current-only familiarity hint;
- `memory.current_fact` — exact `namespace + key + scope` lookup for
  evidence-backed `CURRENT` records explicitly marked `PUBLIC`.

`memory.current_fact` cannot search memory, read history, downgrade
visibility, or expose `PLAYER_SELF`/`STAFF`/`MANAGEMENT`/
`SYSTEM_INTERNAL`/`SECRET_DENY` records. Non-public, missing, stale,
conflicted, unprovenanced, and oversized values all fail closed with the same
public-unavailable result.

Raw ticket/chat text is never stored in the familiarity value. Automatic
learning records only that a verified help interaction occurred, with bounded
provenance; the first interaction remains below the familiarity confidence
threshold, while repeated verified help may suppress repetitive background.
It never auto-promotes a player to `EXPERT`.

Ticket Bot registration is fail-closed: the URL and API key must be configured
together. When configured, only `ticket.capabilities`, `ticket.get_context`,
`ticket.request_close`, and `ticket.request_escalation` are registered.
Lifecycle operations remain action requests that the Ticket Bot independently
authorizes and executes; the agent receives no direct ticket mutation primitive.
The API key remains runtime-only and is never emitted in redacted startup
configuration.

### Staff-only moderation history

`moderation.history` is registered only when both trusted read sides are
configured:

- `ENTHUSIA_AGENT_STAFF_MODERATION_BASE_URL` +
  `ENTHUSIA_AGENT_STAFF_MODERATION_API_KEY`;
- `ENTHUSIA_AGENT_AI_MODERATION_BASE_URL` +
  `ENTHUSIA_AGENT_AI_MODERATION_CLIENT_ID` +
  `ENTHUSIA_AGENT_AI_MODERATION_API_KEY`.

The tool is `STAFF` visibility and performs its own actor check before any
network call. It accepts an exact current Minecraft username, resolves that
target through EnthusiaStaff, and calls AI-Moderation-API only when the Staff
`ai-moderation-state v2` response contains the authoritative current
`ModerationSubjectId`. Staff v1 remains compatible with punishment/case
reads but cannot enable moderation-history enrichment. Missing links, v1
deployments, outages, malformed data, and circuit-open states fail closed.

The moderation-subject UUID is transport-only and is not returned in the tool
result. The result contains only AI-Moderation-API's privacy-minimized effective
decision fields; accepted staff corrections have already replaced superseded AI
outcomes.

**Cross-service identity invariant:** trusted moderation producers must populate
AI-Moderation-API `sender_identity_id` with the same EnthusiaStaff
`ModerationSubjectId` UUID. Names, raw Discord IDs, and Minecraft UUIDs must
never be substituted or inferred. Until that producer convention is deployed
and verified, the tool is source-ready but historical matches are not a
production-readiness claim.

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
the familiarity surface remains subject-bound. The general W05 read is
deliberately limited to exact-key PUBLIC current facts and is not a database
query or memory-search primitive.

## Ticket visual evidence

Ticket evidence is retrieved only through the authenticated Ticket Bot
ticket/message/attachment tuple API. The agent never accepts an attachment URL
from a caller.

Image evidence remains available through the existing bounded image path.
Video evidence additionally requires Ticket Bot `evidence-v2` and a local
media decoder on the agent-service host:

- `ffprobe` must be available on `PATH` for metadata inspection;
- `ffmpeg` must be available on `PATH` for deterministic PNG frame extraction.

Missing or failing decoder binaries do **not** crash the service and do not
disable screenshot review. That video is recorded as a bounded
`processing_failed` evidence issue and the review fails closed.

Current source-level video ceilings are:

- producer byte limit: 25 MiB;
- duration: at most 120 seconds;
- derived frames: at most 3 (aligned with the default per-request external vision-call cap);
- decoded dimensions: at most 4096 on either axis and 2560×1440 total pixels;
- derived PNG frame: at most 8 MiB;
- total local media-processing wall clock: at most 30 seconds;
- per-command timeouts: 5 seconds for `ffprobe`, 8 seconds per `ffmpeg`
  frame extraction;
- accepted containers/MIME types: MP4, WebM, QuickTime;
- accepted video codecs: H.264, HEVC, VP8, VP9, AV1.

Frame timestamps are deterministic. The original video SHA-256, sampled frame
timestamps, frame SHA-256 values, and evidence references are preserved into
the Ticket Bot escalation audit metadata. Sampling is explicitly recorded as
a limitation because events between sampled frames may not be visible.

No full video is sent to a model. Only locally derived, provenance-linked PNG
frames pass through the existing structured image observer. AI output remains
advisory; EnthusiaStaff/staff retain punishment authority.

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
