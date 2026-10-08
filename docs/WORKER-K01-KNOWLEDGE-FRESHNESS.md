# K01 — Knowledge and memory freshness hardening (2026-10-08)

Issue: [#106](https://github.com/wsg138/Enthusia-AI/issues/106).
Scope: existing `services/knowledge-indexer/` and `services/memory/` only.
No production reads/writes or deployments were performed.

## Decisions and implemented safeguards

1. **GitHub source is not automatically deployed.**
   W08 already stamps GitHub artifacts with `contentMetadata.extra.commitSha`
   and `deploymentState: git-main`; W07 previously discarded both during chunking.
   W07 now persists a bounded allowlist of source provenance, including
   `commitSha`, `deploymentState`, `branch`, `blobSha`, observation time,
   content type and parser version. Arbitrary parser extras are not copied.
2. **Production-aware retrieval is explicit and fail-closed for GitHub chunks.**
   `search(question, { visibilityCeiling, production: { deployedGitShas } })`
   requires a separately verified *exact deployed commit SHA*, mapped by
   repository authority (e.g. `github:owner/repo`). A GitHub hit is excluded
   if its indexed commit is absent, missing from the map, or mismatched.
   SHA matching is a provenance guard, **not** evidence that the binary was
   deployed, restarted, or healthy. Only a trusted runtime/tool-layer caller
   may construct this map from approved deployment evidence. Do not populate
   it from model text, `main`, filenames, user assertions or inferred ancestry.
3. **CURRENT-only eligibility is checked again after asynchronous search.**
   A lifecycle update can mark a source `STALE`, `INVALID`,
   `CONFLICTED` or `SUPERSEDED` while embedding/vector search is pending.
   Results are re-filtered just before publication, using the current status,
   visibility ceiling and deployment context. No stale hit may escape simply
   because it passed eligibility before the async operation.
4. **Withdrawn artifacts cannot be reintroduced as CURRENT via text indexing.**
   `indexArtifactText` rejects `status=CURRENT` when
   `SourceArtifact.current=false`. Historical indexing remains available
   with an explicitly historical source status.
5. **Memory re-verification requires actual source-version identity.**
   `MemoryService.verify` requires `confirmedSource` matching existing
   PRIMARY/SUPERSEDING evidence exactly, even for already-CURRENT values.
   Conflicted values require explicit resolution and cannot be reverified.
   A newer source version is not a re-verification: the caller must use
   `supersede` to create a new revision, preserving history. Optional
   `expectedRevisionId` prevents late checks from certifying another
   writer's replacement. The caller must independently observe the source;
   a model-generated or guessed `confirmedSource` is not acceptable.

## Regression coverage

- Asynchronous search lifecycle invalidation while an embedding is pending.
- Missing/mismatched/deployed SHA and exact-match allowed retrieval.
- Staff visibility ceiling remains enforced with matching deployment SHA.
- Source metadata survival on artifact chunking.
- CURRENT indexing rejects `current=false` source artifacts.
- CURRENT and STALE memory cannot gain new verification without matching authoritative evidence.
- Supporting-only claims cannot re-enter CURRENT after staleness.
- Delayed stale verification loses to a concurrent supersession.

Existing W05/W07 tests continue to cover current-only retrieval, explicit history,
conflicts, one CURRENT revision, SQLite durability and optimistic concurrency.

## Limitations and follow-up work

- Production-aware retrieval is **opt-in**, because the current retrieval
  engine also supports intentional source-code research independent of
  deployment. The agent/tool orchestration owner should require the
  production context whenever constructing current-production code answers.
  A missing deployment attestation must produce an unknown/verification-needed
  answer, not a source-based assertion.
- The deployed-SHA map is a trusted caller input, not a live lookup by W07.
  Wiring it to a verified deployment artifact/runtime manifest requires
  coordination with the integration and agent owners; do not infer `main`.
- Artifact status propagation between the source registry and W07 persists
  across separate stores, not one joint transaction. A process crash or
  indexing race can leave temporary registry/retrieval drift; a future
  recovery reconciliation should rebuild eligibility from the source registry.
- W05 still permits creating CURRENT revisions without supporting evidence
  for internal use. Player-facing `memory.current_fact` separately rejects
  unevidenced memories. Future work should distinguish candidate/provisional
  claims from evidence-backed durable truth throughout the write path.
- A `confirmedSource` string cannot cryptographically prove observation.
  Only a trusted re-checking adapter, not a language model, may supply it.
  Autonomous source-change watchers and production rewrites are out of scope.
