# @enthusia/player-identity (W11)

Normalized player identity across Discord and Minecraft — the canonical
identity bridge (spec §69).

## What it owns

- **Discord ID → Minecraft UUID mapping** (the linkage)
- **Current usernames** (with username history)
- **Bedrock identity** where the player linked one
- **Role/rank context** (permission groups, donor rank, staff role)
- **Scope/visibility** for every identity field

## Key principle: PLAYER_SELF linkage

A player's identity **linkage** is `PLAYER_SELF` visibility — visible to the
player themselves and authorized staff, never `PUBLIC` (spec §17). Per-field
visibility is declared in `IDENTITY_FIELD_VISIBILITY` (`src/types.ts`):

| Field | Visibility | Rationale |
|---|---|---|
| `discordId`, `minecraftUuid` | `PLAYER_SELF` | the linkage itself |
| `minecraftName` | `PUBLIC` | already visible in chat/tab list |
| `nameHistory` | `PLAYER_SELF` | private history |
| `bedrock` | `PLAYER_SELF` | private history |
| `ranks` | `PLAYER_SELF` | disclosed only when relevant |

## Relevance-based context (spec §68)

Context access is relevance-based. `getRelevantContext(identity, purpose,
requester, ceiling)` returns **only** what the purpose needs and visibility
allows — it never fetches unrelated private history merely because it can:

| Purpose | Relevant fields |
|---|---|
| `identity-linkage` | `discordId`, `minecraftUuid`, `minecraftName` |
| `rank-question` | `minecraftName`, `ranks` |
| `permission-check` | `minecraftUuid`, `minecraftName`, `ranks` |
| `ticket-support` | `discordId`, `minecraftUuid`, `minecraftName` (history **not** included) |
| `moderation` (staff-only in practice) | all fields incl. `nameHistory`, `bedrock` |
| `server-info` | `minecraftName` only |
| `general` (default) | `minecraftName` only |

Fields the purpose wanted but visibility denied are reported in `withheld`
with a reason — callers can distinguish "not relevant" (absent) from
"relevant but not disclosable" (withheld).

## Orchestrator tools

- `identity.resolve` — resolve Discord ID / UUID / username → UUID +
  current username + rank context. `privacySensitive: true`,
  `maxVisibility: PLAYER_SELF`.
- `identity.context` — purpose-scoped context via `getRelevantContext`.

Both return §16.2 `ToolResult` envelopes and never echo private payloads
in error messages. The `Tool`/`ToolMetadata`/`ToolCallContext` shapes are
structurally identical to W12's `services/agent-core/src/tool.ts`, so these
tools register directly into W12's `ToolRegistry` after merge (this package
does not depend on `@enthusia/agent-core`; W12's code is untouched).

## Store

`InMemoryIdentityStore` — mock backing seeded with fictional players in
tests. **No real Discord/Minecraft APIs. No production data.** A production
backing (via W12/W10 tooling) implements the same `IdentityStore`
interface.

## Layout

```
services/player-identity/
  src/
    types.ts    — identity model, purposes, per-field visibility
    store.ts    — IdentityStore interface + in-memory implementation
    service.ts  — resolution, visibility enforcement, getRelevantContext
    tool.ts     — identity.resolve / identity.context orchestrator tools
    index.ts    — public API
  test/
    mocks.ts    — fictional players (mock data only)
    store.test.ts
    service.test.ts
    context.test.ts
    tools.test.ts
```

Run: `npx vitest run services/player-identity` from the repo root.


## Topic familiarity

Issue #33 adds a deliberately narrow response-style surface:

`player.topic_familiarity({ topic })`

The target player is **not** a tool parameter. The tool binds to the authenticated
player actor in the request context, so the local model cannot turn it into a
general player-profile lookup.

The result is limited to:

- `NEW | FAMILIAR | EXPERT | UNKNOWN`;
- confidence from 0 to 1;
- coarse evidence classes (`CURRENT_CONTEXT`, `CURRENT_MEMORY`,
  `CONVERSATION`);
- observation time.

It never returns the underlying memory text, ticket text, account history, or
other private evidence used by a future provider to derive the signal.

The agent core uses the signal only to choose how many already-verified
background claims to show:

- `NEW`: include verified introductory/background facts;
- `FAMILIAR` / `EXPERT`: skip repetitive background and keep the direct answer;
- `UNKNOWN`: include at most one short verified context fact.

Factual verification remains unchanged. Familiarity cannot make an unverified
claim true, cannot alter tool authorization, and is not emitted as a response
citation.
