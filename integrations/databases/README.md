# @enthusia/integration-databases — Database safe tools (W10)

Read-only database access for Enthusia AI, per
`MASTER-SPECIFICATION.md` §§16.1, 25 and `WORKER-EXECUTION-PLAN.md` §13.

**Goal:** expose current live database facts without giving the model
arbitrary database power.

## The safety model

1. **No arbitrary SQL, ever.** The only SQL text that can reach a driver is
   one of the five templates in `src/query-templates.ts`, validated at module
   load (single `SELECT`, no `;`, no comments, no string literals, no
   write/DDL keywords, placeholder count matches). There is no public function
   anywhere in this package that accepts SQL text. `getQueryTemplate` takes a
   registry key; unknown keys throw `UNKNOWN_QUERY_TEMPLATE`.
2. **Model input becomes bound values only.** Tool params are validated with
   zod (UUIDs, digit-only snowflakes, strict charsets, an allowlisted economy
   fact enum). The connection manager additionally rejects non-scalar params
   and verifies the placeholder count before calling the driver.
3. **Read-only by construction.** `DatabaseConfig.readOnly` is `z.literal(true)`;
   the manager refuses anything else. Deployments must use a separate
   read-only database account (§25.3).
4. **Credentials never leave the tool layer** (§5.5). They come from
   `ENTHUSIA_DB_*` env vars, never appear in tool output, provenance, logs,
   or error messages (messages are scrubbed; the log-safe config view has no
   password key at all).
5. **Row limits.** `maxRows` (default 25, hard ceiling 100) is enforced by
   the driver contract and re-enforced by the manager; truncation is flagged
   in `freshness`.
6. **Timeouts.** Every query runs under `queryTimeoutMs` (default 5000ms);
   overruns report retryable `DB_TIMEOUT`.
7. **Visibility.** Every tool declares `privacySensitive: true` and a
   `maxVisibility`; results are filtered with `canDisclose`, including
   `PLAYER_SELF` identity checks and per-row ticket subject filtering.

## The five tools

| Tool | Params | Visibility |
|---|---|---|
| `db.resolve_linked_account` | `discordId` | `PLAYER_SELF` |
| `db.get_player_rank` | `playerUuid` | `PLAYER_SELF` |
| `db.get_permission_state` | `playerUuid`, `permissionNode` | `PLAYER_SELF` |
| `db.get_ticket_metadata` | `ticketId` | `PLAYER_SELF`/`STAFF`, subject filtered per row |
| `db.get_economy_fact` | `playerUuid`, `factType` (allowlisted) | `PLAYER_SELF` |

All implement the W12 `Tool` interface shape (mirrored in
`src/tool-adapter.ts` — structural copy of
`services/agent-core/src/tool.ts`, W12; do not modify W12's code) and plug
into W12's `ToolRegistry`. Every result is a `ToolResult` envelope with full
§16.2 provenance: tool name, timestamp, source (`database:live:<view>`),
visibility, correlation ID, and freshness JSON
(`observedAt`, `sourceStatus: 'CURRENT'`, `queryTemplate`, `rowCount`,
`truncated`).

## Configuration

```sh
ENTHUSIA_DB_HOST=...        # required
ENTHUSIA_DB_PORT=3306       # optional
ENTHUSIA_DB_NAME=...        # required
ENTHUSIA_DB_USER=...        # required (read-only account)
ENTHUSIA_DB_PASSWORD=...    # optional (empty for socket auth)
ENTHUSIA_DB_QUERY_TIMEOUT_MS=5000   # optional, 100..60000
ENTHUSIA_DB_MAX_ROWS=25             # optional, 1..100
```

See `.env.example` at the repo root for the full list (no secrets committed).

## Wiring a real driver

This package bundles **no database driver** and makes **no real connections**.
`defaultDbClientFactory` fails closed with `DB_DRIVER_NOT_CONFIGURED`.
Deployments inject a `DbClientFactory` implementing the `ReadOnlyDbClient`
port (e.g. over `mysql2/promise` with the read-only account):

```ts
const manager = new DatabaseConnectionManager(config, myReadOnlyFactory);
const toolset = new DatabaseToolset(manager);
registry.register(toolset.get('db.get_player_rank')!); // W12 ToolRegistry
```

Schema descriptions for the approved read views live in `src/schema.ts` and
feed the W04 source registry / W07 index as `DATABASE_SCHEMA` artifacts
(shape only — never live rows).

## Tests

76 unit tests, mock database only (`MockReadOnlyDbClient`) — no real
connections, no production data:

- happy paths + not-found for all five tools (`tools.test.ts`)
- SQL injection resistance: 8 hostile payloads stay bound params; no
  SQL-accepting export exists; unknown templates and non-scalar params
  rejected (`sql-injection.test.ts`)
- template registry validation (`query-templates.test.ts`)
- row limits incl. rogue-driver re-enforcement (`row-limits.test.ts`)
- timeouts (`timeout.test.ts`)
- visibility: strangers denied, ceilings enforced, ticket subjects filtered
  (`visibility.test.ts`)
- §16.2 provenance on every result (`provenance.test.ts`)
- W12 Tool interface conformance (`tool-conformance.test.ts`)
- config validation + credential hygiene (`config.test.ts`)

```sh
npx vitest run integrations/databases   # from the repo root
```
