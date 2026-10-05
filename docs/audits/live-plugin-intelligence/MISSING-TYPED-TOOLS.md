# Missing typed-tool recommendations

These are the highest-value typed read surfaces revealed by the live plugin intelligence audit.

They are recommendations, not authorization for arbitrary shell, unrestricted file access, database access or deployment controls.

## Current plugin deployment resolver

Suggested operation:

`plugin.current_deployment(server, plugin_id)`

Returns:

- target server;
- deployed filename;
- SHA-256;
- version/main class;
- enabled/runtime identity;
- source/release provenance when known;
- capture time;
- confidence/freshness;
- current health state.

Why: prevents GitHub main or stale memory from overriding the running binary.

## Feature-state resolver

Suggested operation:

`plugin.feature_state(server, plugin_id, feature_key)`

Returns one of:

- ACTIVE;
- DISABLED;
- DEGRADED;
- FAIL_CLOSED;
- INTERMITTENT;
- UNAVAILABLE;
- UNKNOWN.

Why: a command/class/config key existing does not prove a feature currently works.

## Permission-aware command/help resolver

Suggested operation:

`plugin.command_help(server, command, audience_context)`

Returns:

- whether the command is currently registered/available;
- player-safe usage/help;
- relevant access requirement without exposing internal-only syntax unnecessarily;
- feature-disabled reason if relevant;
- source/freshness.

Why: lets support answer “how do I...” without training on bare plugin metadata or leaking staff-only command syntax.

## Safe config query

Suggested operation:

`plugin.config_get(server, plugin_id, approved_key_path)`

Properties:

- allowlisted roots/keys;
- protected-value filtering;
- no arbitrary filesystem path;
- no raw file dump by default;
- provenance/capture time;
- audience filter after retrieval.

Why: mutable values such as guild-home cost, RTP uses and mail cooldowns belong in current retrieval rather than model weights.

## Runtime health summary

Suggested operation:

`server.runtime_health(server, plugin_id?, since?)`

Returns aggregated/system-level health only:

- warning/error counts;
- normalized issue fingerprints;
- first/last seen;
- current vs historical;
- known issue linkage;
- no player-linked detail by default.

Why: the audit found real current degradations from runtime evidence that source/config could not reveal.

## Deployment/source comparison

Suggested operation:

`plugin.compare_source_to_deployment(server, plugin_id)`

Returns:

- production hash;
- matching release/CI/source commit if proven;
- divergence status;
- registry-stale/current classification;
- no deployment action.

Why: this audit found stale registered sources for Express, LumaGuilds and Market.

## Network freshness resolver

Suggested operation:

`network.target_freshness(target)`

Returns:

- last successful read;
- source type;
- current-coverage status;
- CURRENT / STALE / UNKNOWN;
- allowed use category.

Why: prevents stale network snapshots from being presented as current.

## Player familiarity/context hint

Use the existing player identity/context and memory systems to expose only a minimal response-style hint:

`player.topic_familiarity(player, topic)`

Possible result:

- NEW;
- FAMILIAR;
- EXPERT;
- UNKNOWN;

with confidence, without returning private memory text unnecessarily.

Why: supports adaptive explanation depth without baking familiarity into static training facts.

## TicketBot deployment capability check

Before any TicketBot action integration:

`ticketbot.capabilities()`

Returns the actually deployed API contract/version and available actions.

Why: the internal API is merged but currently not deployed. The AI must not attempt an endpoint merely because source main contains it.

## Hard boundaries

Do not add generic operations that amount to:

- arbitrary shell;
- unrestricted file traversal;
- arbitrary database query;
- broad write access;
- restart/reload/deploy controls mixed into read tools;
- protected-value retrieval.

Any future mutation surface should be independently authorized, narrowly typed, deterministic around policy/auth, and idempotent where possible.
