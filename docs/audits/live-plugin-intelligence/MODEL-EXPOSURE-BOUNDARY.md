# Model exposure and redaction boundary

Purpose: define the separation between what a privileged read gateway may access and what may enter model context, retrieval indexes, logs, memory or training data.

## Current audit result

The sanitized server mirror already redacts many authentication and authorization values.

No authentication material is intentionally copied into this audit.

The mirror can still contain internal identifiers and infrastructure metadata that are not reusable credentials but should not automatically become player-visible or training content.

Therefore the sanitized mirror is an input boundary, not the final model-exposure boundary.

## Never model-visible

Authentication material and reusable authorization material must never be returned to the model, written into retrieval indexes, stored in conversational memory or admitted to training corpora.

The model may know that a protected integration exists and that a typed gateway can use it. It must not receive the reusable authorization value itself.

## Internal-only by default

These may be available to authorized staff/debug tools when relevant, but ordinary player responses should omit them:

- internal service identities;
- private infrastructure hostnames and topology;
- internal storage identifiers;
- private server IDs;
- staff-only permission details;
- internal filesystem paths;
- backend exception stacks;
- migration/conflict identifiers;
- per-player unique identifiers unless required for the authorized task.

## Player-sensitive data

Do not place player-linked private data into broad training or retrieval simply because it exists in a live data file or log.

Use request-time typed tools with authorization and minimum disclosure for private account linkage, private support content, staff evidence, private messages and other player-specific state.

## Generally safe when relevant

Examples of current evidence suitable for normal retrieval after audience checks:

- plugin name/version/hash;
- feature enabled/disabled/degraded state;
- public command semantics;
- public help/messages;
- public economy/reward configuration;
- server integration health;
- redacted config structure;
- dependency names;
- deployment provenance;
- non-sensitive issue identifiers and health summaries.

## Two-stage sanitization

1. **Source sanitization**
   - mirror/gateway removes protected values before storage or indexing.
2. **Model exposure policy**
   - request-time layer filters by audience and purpose before context injection.

This preserves the intended architecture: the AI may use protected systems through controlled tools without possessing reusable authentication material.

## Training rule

Never train directly on raw live configs, logs or state dumps merely because they were mirrored.

Training/source preparation must:

- run redaction and sensitive-data scans;
- enforce path/file deny rules;
- exclude player-private/stateful records unless separately governed;
- prefer curated stable source facts over volatile mutable values;
- keep current runtime facts in retrieval/current-memory layers rather than weights.
