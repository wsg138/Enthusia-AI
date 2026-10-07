# @enthusia/moderation-adapter (W15)

Direct, failure-isolated integration with the **separate AI-Moderation-API**
service. Moderation remains a sibling process/model with independent health and
release lineage.

## Live cross-repo contract

This package now targets the reviewed Policy-v1 support-enrichment boundary in
`wsg138/AI-Moderation-API`, introduced on `main` by commit
`9e4e83416eb21f4bfa7a8b9a5f646adbda14778a` (service version 0.2.0,
SQLite schema v3):

- `GET /health/ready` — unauthenticated readiness;
- `GET /v1/support-context/{subject_id}?limit=N` — authenticated,
  privacy-minimized effective moderation history;
- authenticated `/v1/*` requests require both:
  - `X-Client-Id: <AI_MOD client id>`
  - `Authorization: Bearer <runtime secret>`;
- the support-context client must have the dedicated `support:context`
  permission.

The support-context endpoint is introduced alongside moderation SQLite schema
v3 (the authoritative-identity/time lookup index). Future additive schema
versions are allowed, but deployments must expose the support-context endpoint
and permission described above.

There is no `POST /v1/decisions/context` dependency and no Bearer-only
authentication assumption.

## Identity boundary

`SharedIdentityMetadata.moderationSubjectId` must be an **authoritative
canonical identity ID** previously sent to AI-Moderation-API as
`sender_identity_id` by a trusted integration.

Do not substitute:

- usernames;
- display names;
- unlinked Minecraft UUID/name guesses;
- raw Discord IDs unless the authoritative linking system defines that exact
  value as the canonical identity.

The moderation service does not fall back from canonical identity to raw
platform sender IDs.

## Data minimization

The adapter allowlists only the fields returned by the reviewed support-context
contract:

- event ID/time and platform;
- semantic label;
- message action;
- review priority;
- strike recommendation;
- containment;
- support flow;
- bounded reason codes;
- decision source (`AI` or `ACCEPTED_CORRECTION`).

Raw message text, neighboring chat, channel/scope IDs, raw platform sender IDs,
review notes, scores, and arbitrary moderation database rows are not represented
in `ModerationDecision`. Unknown response fields are discarded.

Accepted staff corrections are already applied by AI-Moderation-API before the
effective decision reaches this adapter.

## Failure isolation

`ModerationAdapter.enrichContext()` is optional support enrichment:

- it never throws to the support pipeline;
- network/timeout/malformed-response failures become
  `{ context: null, moderationAvailable: false }`;
- the circuit breaker stops repeated calls to a down moderation service;
- moderation history never gates whether support may answer;
- this package never performs live moderation or punishment actions.

The reverse dependency also does not exist: AI-Moderation-API never calls this
adapter or depends on the support LLM.

## Readiness semantics

AI-Moderation-API returns:

- HTTP 200 + `{ status: "ready", ready: true, ... }` when ready;
- HTTP 503 + `{ status: "not_ready", ready: false, ... }` when the process is
  reachable but not ready.

The client treats the structured 503 as **degraded/reachable**. Network errors,
timeouts, unexpected HTTP failures, and malformed readiness payloads are
unreachable failures.

Credentials are not sent to the unauthenticated health endpoint.

## Example

```ts
import { ModerationAdapter } from '@enthusia/moderation-adapter';

const adapter = new ModerationAdapter({
  client: {
    baseUrl: 'http://moderation:8080',
    clientId: process.env.AI_MOD_SUPPORT_CLIENT_ID!,
    apiKey: process.env.AI_MOD_SUPPORT_API_KEY!,
  },
  circuitBreaker: { failureThreshold: 3, cooldownMs: 30_000 },
});

const { context } = await adapter.enrichContext({
  supportSubjectId: 'player-uuid-1234',
  moderationSubjectId: 'canonical-identity-1234',
});

// context may be null; support must continue either way.
```

## Tests

The unit/contract fixtures mirror the reviewed live API shape and cover:

- two-header `/v1/*` authentication;
- no credentials on `/health/ready`;
- 200 ready vs structured 503 not-ready behavior;
- canonical-identity URL encoding and 1..25 limit;
- subject-mismatch rejection;
- allowlisted decision normalization / unknown-field dropping;
- accepted-correction decision source;
- malformed/down/hanging service fail-soft behavior;
- circuit opening and recovery.

No real moderation service is contacted by the test suite.
