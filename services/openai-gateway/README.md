# @enthusia/openai-gateway (W13)

Strong-model/coding escalation path for Enthusia AI. W12's agent core
investigates locally and builds the structured §22.2 investigation packet;
this service gates (policy), formats, sends (OpenAI chat completions),
budgets, and normalizes the result to the `AgentResponse` contract.

Spec: `MASTER-SPECIFICATION.md` §§22, 37, 46, 89; `WORKER-EXECUTION-PLAN.md` §16.
Spec wins on any disagreement.

## Layout

- `src/models.ts` — explicit model selection policy: which model per
  escalation kind (`coding`, `debugging`, `investigation`, `architecture`,
  `analysis`), plus the operator-maintained price table.
- `src/packet.ts` — structural mirror of W12's `InvestigationPacket` plus
  `validateInvestigationPacket()` / `assertValidInvestigationPacket()`.
  W12 owns the builder; this package must not drift from it.
- `src/escalation-policy.ts` — policy adapter: consumes W12's escalation
  decision, allows only `target: 'openai'`, enforces the §37 per-request
  call cap and packet↔decision consistency.
- `src/packet-format.ts` — formats the packet into chat messages
  (system operating instructions + structured §22.2 user context).
- `src/openai-client.ts` — dependency-free chat completions client with
  timeout handling; base URL configurable for the mock server.
- `src/budget.ts` — `CostTracker`: token/cost logging, estimated cost,
  per-request and per-day caps enforced *before* the call, spend summary
  for §37 per-day visibility.
- `src/config.ts` — env-driven config (`loadConfig`). Runtime OpenAI
  budget is separate from the training GPU $25 cap.
- `src/response-normalize.ts` — converts the completion to the
  `AgentResponse` contract (raw output + evidence citations + audit trail).
- `src/index.ts` — `runEscalation()`: validate → policy → format →
  budget pre-check → call → record spend → normalize.

## Configuration

| Env | Default | Meaning |
| --- | ------- | ------- |
| `OPENAI_API_KEY` | _(unset)_ | API key. Escalation refuses without one. Injected at deploy time only. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API base; point at a mock server for tests. |
| `ENTHUSIA_OPENAI_TIMEOUT_MS` | `120000` | Request timeout. |
| `ENTHUSIA_OPENAI_MAX_OUTPUT_TOKENS` | `4096` | Completion cap (also used for pre-call budget estimates). |
| `ENTHUSIA_OPENAI_REQUEST_BUDGET_USD` | `2` | Per-request spend cap. |
| `ENTHUSIA_OPENAI_DAILY_BUDGET_USD` | `10` | Per-day (UTC) spend cap. |
| `ENTHUSIA_OPENAI_MAX_ESCALATIONS_PER_REQUEST` | `3` | Max escalation calls per request (§37). |
| `ENTHUSIA_OPENAI_MODEL_CODING` / `_DEBUGGING` / `_INVESTIGATION` / `_ARCHITECTURE` / `_ANALYSIS` | see `models.ts` | Per-kind model override. |

## Security notes

- The API key is read from config only; it is never logged, never appears
  in error messages, and never leaves this process except in the
  `Authorization` header of the configured API call.
- `SECRET_DENY` evidence is dropped defensively at format time (§17.6), in
  addition to W12's packet-level redaction.
- Coding authority (§22.4, §89): the system prompt authorizes read-only
  analysis and proposals through explicit GitHub workflows only — no
  merge, deploy, restart, or live-data mutation without separate owner
  authorization.
- Tests must NEVER use a real API key or hit `api.openai.com`: they use a
  fake key against a local mock server. Fake keys in this repo must not
  look real (no `sk-` prefix) so secret scans stay clean.

## Running tests

```sh
npm test -w @enthusia/openai-gateway
```

Unit tests live in `test/` and use a local `node:http` mock of the
`/chat/completions` endpoint — no network, no real keys.
