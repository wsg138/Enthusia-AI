# @enthusia/moderation-adapter (W15)

Integrates with the **separate moderation AI** without coupling availability.

## Design (spec §10.1, §21)

Moderation is a *sibling system*: separate process, separate model, independent
health. This adapter:

- owns an **HTTP client** to the moderation API (`client.ts`) — direct
  connection, **never** routed through the AI Gateway or the support LLM;
- reads **recent moderation decisions** as *optional support context*
  (`adapter.ts`) — never as real-time verdicts, and never gating a support
  response;
- carries **shared identity metadata** (`types.ts`) — opaque mapping between
  support-side and moderation-side identities, forwarded verbatim;
- isolates failures with a **circuit breaker** (`circuit-breaker.ts`).

## Key guarantees

1. **Fire-and-forget enrichment.** `ModerationAdapter.enrichContext()` never
   throws and never blocks support. Moderation down →
   `{ context: null, moderationAvailable: false }`; the support pipeline
   proceeds exactly as if no moderation history existed.
2. **Circuit breaker.** After `failureThreshold` consecutive failures the
   circuit opens and calls short-circuit locally (no network I/O) until a
   half-open probe succeeds after `cooldownMs`. A downed moderation service
   costs support zero blocking time once the circuit opens.
3. **Timeouts everywhere.** Per-request AbortController timeouts plus an
   outer enrichment timeout; a hanging moderation service degrades to
   "no context", never to a stalled support response.
4. **Independent health.** Status is queried directly (`GET /health`);
   `moderationDependencyHealth()` maps it into the shared `@enthusia/contracts`
   `DependencyHealth` shape for §36 observability (W21). Nothing here
   consults or requires AI Gateway availability.
5. **No secrets in logs.** The optional Bearer token is sent only to the
   configured `baseUrl`; error messages never include it (§5.5).

## Wire API (expected of the external moderation service)

- `GET /health` → `{ status: 'ok' | 'degraded' | 'down', version? }`
- `POST /v1/decisions/context` with `{ subjectId, limit }` →
  `{ subjectId, decisions: [{ id, subjectId, verdict: 'clean'|'flagged'|'blocked', categories, summary, decidedAt, appealed? }] }`

The fetch implementation is injected (`client.fetchFn`; defaults to
`globalThis.fetch` when configured, mock in tests). **There is no real
moderation service connection in tests or in this package** — tests use
`test/mocks.ts`.

## Usage

```ts
import { ModerationAdapter } from '@enthusia/moderation-adapter';

const adapter = new ModerationAdapter({
  client: { baseUrl: 'http://moderation:8080', apiKey: process.env.MODERATION_API_KEY, fetchFn: globalThis.fetch },
  circuitBreaker: { failureThreshold: 3, cooldownMs: 30_000 },
});

// Fire-and-forget: never throws, never blocks support.
const { context, moderationAvailable } = await adapter.enrichContext({
  supportSubjectId: 'player-uuid-1234',
  moderationSubjectId: 'mod-subject-42',
});
const reply = await supportPipeline(userMessage, context /* may be null */);

// Observability (W21): independent status query.
const status = await adapter.getModerationStatus(); // 'reachable' | 'degraded' | 'unreachable' | 'circuit-open'
const dependency = await adapter.moderationDependencyHealth();
```

## Tests

33 unit tests with a mock moderation API (`test/`): client behavior
(status query, decision normalization, error mapping), circuit-breaker state
transitions, and failure isolation (moderation down → support continues,
open-circuit short-circuits with zero network calls, recovery via half-open).
