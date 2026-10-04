# Enthusia AI Command

Paper plugin exposing the Enthusia AI platform in-game via `/ai`.
**Workstream W22** — `minecraft/ai-command/`.

The plugin is intentionally thin (MASTER-SPECIFICATION.md §6.3, §19):

- authenticates the sender (player UUID / username, console);
- attaches server + player context (server name, world, location);
- enforces a per-player token-bucket rate limit;
- calls the AI Gateway (W02) `POST /v1/chat` **asynchronously** — never on the main thread;
- renders the answer as safe, Bedrock/Geyser-compatible chat text;
- degrades gracefully when the gateway is unavailable.

It performs **no reasoning of its own**. All intelligence lives in the
gateway → orchestrator (W12) → tools/memory stack.

## Commands

| Command | Permission | Description |
|---|---|---|
| `/ai <question>` | `enthusia.ai.use` | Ask the AI (visibility ceiling `PLAYER_SELF`) |
| `/ai ask <question>` | `enthusia.ai.use` | Same as above |
| `/ai history` | `enthusia.ai.use` | Show your recent questions |
| `/ai clear` | `enthusia.ai.use` | Start a new conversation |
| `/ai help` | `enthusia.ai.use` | Usage |
| `/ai staff ask <question>` | `enthusia.ai.staff` | Staff-visibility query (ceiling `STAFF`, sources shown) |
| `/ai staff status` | `enthusia.ai.staff` | Gateway liveness + readiness |
| `/ai staff reload` | `enthusia.ai.admin` | Reload `config.yml` |
| `/ai staff ratelimit clear <player>` | `enthusia.ai.admin` | Reset a player's rate-limit bucket |

Console may use `/ai` directly (actor type `system`, ceiling `STAFF`).

## Configuration (`config.yml`)

```yaml
gateway:
  base-url: "http://127.0.0.1:4100"  # AI Gateway (W02)
  api-key: "${ENTHUSIA_AI_GATEWAY_API_KEY}"   # Bearer token; env expansion supported
  request-timeout-ms: 30000
rate-limit:
  max-per-minute: 10                  # per-player token bucket
messages:
  max-line-chars: 200
server:
  name: "smp"                         # sent as context.serverName
debug: false
```

## Gateway contract

Requests follow `@enthusia/contracts` `ChatRequest` exactly:

```json
{
  "surface": "minecraft",
  "actor": {"id": "<uuid>", "type": "player", "displayName": "Steve",
            "linkedUuid": "<uuid>"},
  "conversationId": "<uuid>",
  "message": "what is the ip?",
  "context": {"serverName": "smp", "worldName": "world",
              "worldEnvironment": "NORMAL", "playerLocation": "10,64,-5"},
  "visibilityCeiling": "PLAYER_SELF",
  "traceId": "<uuid>"
}
```

`POST /v1/chat` → `AgentResponse`; `GET /health/live`, `GET /health/ready`
for status. Error envelope `{error: {code, statusCode, message, traceId}}`
maps to player-safe chat messages — internal detail is logged server-side
only, never sent to chat.

## Building

Requires JDK 25 and Maven. Paper API is `provided` scope; the jar has no
runtime dependencies (JSON is hand-rolled, no shading needed).

```bash
cd minecraft/ai-command
mvn -B verify
```

Tests: `mvn -B test` — unit tests for command parsing, rate limiting,
conversation continuity, request building, formatting, plus `GatewayClient`
tests against a mock HTTP server and `AiCommandExecutor` tests with mocked
Bukkit objects. No live server or gateway is required.

## Safety notes

- AI output is sanitized: injected `§`/`&` formatting codes are stripped or
  escaped, control characters removed, lines wrapped at word boundaries.
- Output is plain text only (no click/hover events) for Bedrock/Geyser safety.\n- Total response text and rendered line count are bounded before sending to chat.\n- Gateway I/O runs in a dedicated bounded executor that is interrupted and fenced on plugin disable.
- The gateway enforces its own actor-type visibility ceilings on top of the
  plugin's (`player` → max `PLAYER_SELF`, `staff` → max `STAFF`).
- Never commit a real API key — use `${ENTHUSIA_AI_API_KEY}`.
