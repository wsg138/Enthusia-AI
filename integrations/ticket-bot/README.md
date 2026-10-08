# @enthusia/integration-ticket-bot (W14)

Ticket Bot lifecycle integration for Enthusia AI.

**Spec:** `MASTER-SPECIFICATION.md` §6.2 (ticket support), §20 (Ticket Bot separation and migration).
**Worker plan:** `WORKER-EXECUTION-PLAN.md` §17.

## The invariant

The Ticket Bot remains the **source of truth** for ticket state and permissions.
Enthusia AI **REQUESTS** actions; the Ticket Bot validates and executes them.

| Ticket Bot owns (stays) | Enthusia AI owns (moves here) |
|---|---|
| ticket creation, permissions, channel lifecycle, close confirmation, transcripts, archiving, applications, staff permission enforcement, ticket persistence | AI reasoning, response generation, ticket understanding, memory, knowledge retrieval, server investigation, external-model escalation |

## What this package provides

- **`src/types.ts`** — ticket domain types: `Ticket`, `TicketStatus`, `TicketMessage`,
  `TicketParticipant`, `ActionRequestKind` (`close` | `reopen` | `escalate` | `add_note` | `transition`),
  `ActionRequestInput`/`ActionRequestResult`, pagination.
- **`src/client.ts`** — `TicketBotClient`, a typed HTTP client:
  - reads: `getTicket`, `listTickets`, `getTicketMessages`, `getTicketParticipants`,
    `getTicketContext`, `getActionRequest`
  - action requests: `requestAction` (+ `requestClose`, `requestReopen`,
    `requestEscalation`, `requestAddNote` conveniences)
  - **No direct mutation is possible.** `TICKET_BOT_REQUEST_ALLOWLIST` permits only
    GETs on ticket-scoped resources and POSTs to
    `/v1/tickets/{id}/actions/request`. `assertAllowedRequest` throws for anything
    else *before* any network I/O. There is no PUT/PATCH/DELETE anywhere.
- **`src/events.ts`** — one-directional event consumption (Ticket Bot → Enthusia AI):
  `parseTicketEvent` (zod-validated), `TicketEventRouter` (typed + wildcard
  subscriptions), duplicate `event_id` suppression, and `verifyWebhookSignature`
  (HMAC-SHA256).
- **`src/event-dedup.ts`** — claim/complete/release interface for retryable webhook
  delivery. The default bounded store is process-local for tests/shadow use.
  A subscriber failure releases the claim and causes ingest to reject, so
  callers can retry. Production ingress must inject a durable store with
  **expiring in-flight leases**, atomic claims, permanent completed markers,
  and recovery after process crashes. A uniqueness-only store is insufficient.
  At-least-once delivery requires each downstream handler to be idempotent.
- **`src/context.ts`** — `ticketToAgentContext`: pure adapter from ticket data to
  agent context (no I/O, no mutation). Classifies output as `PLAYER_SELF` (§17);
  the orchestrator's visibility ceiling decides disclosure.
- **`src/tools.ts`** — agent tools shaped to W12's `Tool` interface
  (`meta` + `execute`, §16.2 provenance envelopes):
  `ticket.get_context`, `ticket.request_close`, `ticket.request_escalation`.
  Lifecycle request tools re-read the Ticket Bot's persisted action-request status
  and add `verification` + `canReportSuccess`. Only a matching persisted
  `accepted` result sets `canReportSuccess: true`; pending, rejected, mismatched,
  or unreadable status remains non-success. All are `privacySensitive: true`,
  `maxVisibility: STAFF`. There is deliberately **no** `ticket.close` /
  `ticket.mutate` tool. The interface is defined
  structurally here so these tools can register into W12's `ToolRegistry`
  (`registry.register(tool)`) without this package depending on W12's code.

## Usage

```ts
import {
  TicketBotClient,
  TicketEventRouter,
  createTicketTools,
  ticketToAgentContext,
} from '@enthusia/integration-ticket-bot';

const client = new TicketBotClient({
  baseUrl: process.env.TICKET_BOT_URL!,
  apiKey: process.env.TICKET_BOT_API_KEY!, // Bearer token; never logged
});

// Read context for reasoning:
const bundle = await client.getTicketContext('T-1234', { maxMessages: 20 });
const ctx = ticketToAgentContext(bundle, { traceId: 'trace-1' });

// Request (never perform) a lifecycle action:
const req = await client.requestClose('T-1234', 'Claim restored; player confirmed.');
// => { requestId: 'ar-1', action: 'close', status: 'accepted' | 'pending' | 'rejected', ... }
if (req.status === 'pending') {
  const later = await client.getActionRequest(req.requestId);
}

// Consume lifecycle events:
const router = new TicketEventRouter();
router.subscribe('ticket.closed', (e) => console.log('closed:', e.ticketId));
await router.ingest(rawWebhookPayload); // validates, deduplicates, then dispatches

// Agent tools (register into the orchestrator's ToolRegistry):
const tools = createTicketTools(client);
for (const tool of tools) registry.register(tool);
```

## Runtime safety gates

- Ticket action submission still performs the authenticated `/v1/capabilities`
  handshake before POSTing an action request.
- The close/escalation agent tools then re-read the persisted action-request
  record. A user-facing completion claim is permitted only when that read
  matches the submitted request and reports `accepted`.
- Duplicate Ticket Bot events are suppressed by stable `event_id` before
  subscriber side effects run. The built-in store is process-local and bounded;
  production webhook ingress must inject a durable store with an atomic unique
  claim before at-least-once delivery is enabled.
- If deduplication persistence is unavailable, ingress fails closed and does not
  dispatch the event. If action-status verification is unavailable, the tool
  returns `verification: "unverified"` and `canReportSuccess: false` rather
  than guessing that the lifecycle action completed.

## Error mapping

HTTP status → `@enthusia/contracts` errors: 400 `ValidationError`, 401/403
`AuthorizationError`, 404 `NotFoundError`, 409 `ConflictError`, 429
`RateLimitError`, 5xx / network / timeout → `ExternalServiceError('ticket-bot', …)`.
Tool failures never throw: they return `ToolResult` error envelopes with
machine-readable codes and a `retryable` flag (retryable only for transient
failures).

The API key travels only in the `Authorization` header and is scrubbed from
every error path (covered by tests).

## Migration strategy (documented, not implemented)

Per spec §20.1, the existing Ticket Bot's embedded AI logic migrates behind
Enthusia AI in this order. **Do not rip out current AI first.**

1. **Shadow existing AI decisions.** Run this package's tools alongside the Ticket
   Bot's current AI: fetch the same ticket context, run Enthusia AI reasoning,
   and log what action (if any) it *would* request — without submitting requests.
2. **Compare results.** Diff shadow decisions against the Ticket Bot's actual
   decisions over real traffic; investigate every divergence before proceeding.
3. **Migrate reads/context.** Switch AI reasoning to `getTicketContext` /
   `ticket.get_context` as the context source (Ticket Bot stays the data authority).
4. **Migrate response generation.** Route AI-generated replies through
   `requestAddNote` so the Ticket Bot owns delivery, transcript, and audit.
5. **Migrate memory/knowledge.** Move ticket-derived memory writes to W05/W07
   behind this package's context adapter.
6. **Migrate visible AI messages.** Send Discord AI messages under the Enthusia AI
   identity where Discord architecture permits (§6.2); the Ticket Bot still owns
   channel lifecycle.
7. **Remove old duplicate AI authority last.** Only after the shadow comparison
   is stable and the rollback path (below) is verified.

**Rollback path (preserved until stable):** every phase keeps the Ticket Bot's
current AI path intact and switchable via configuration; phase 7 is the only
destructive step and requires the shadow comparison to be green for a full
operational cycle first.

**Coordinated Ticket Bot changes** (separate workstream, `wsg138/enthusia-support-bot`
repo — NOT this package): the typed endpoints/events above
(`GET /v1/tickets/{id}`, `POST /v1/tickets/{id}/actions/request`, event payloads)
are the contract that workstream implements. This package must never be pointed
at a Ticket Bot that does not implement them.

## Testing

```sh
npm test --workspace=@enthusia/integration-ticket-bot
# or from the repo root: npm test  (integrations/*/test/** is included)
```

Tests use a mock Ticket Bot API (no real connection) and pin the no-mutation
invariant: every request the client issues is recorded and asserted to be an
allowlisted read or action request.
