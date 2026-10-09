# W08 + W04 + W07 real-component composition proof (2026-10-08)

**Status:** Isolated unit/integration TEST ONLY, no credentials, no live GitHub request, not connected to Discord or production.

This milestone follows owner-confirmed isolated Discord Q&A success (see [LOCAL-DISCORD-UX-2026-10-08.md](LOCAL-DISCORD-UX-2026-10-08.md)).

## Why

The first public answers for PieCloak and Warzones were intentionally constrained to two known public READMEs. That works for test Q&A but does not scale to the server's many systems, and does not answer mutable questions such as "why is the server lagging?"

The repository already contains:
- **W08** \`GitHubIndexer\`: approved-repository ingestion, commit/blob provenance, secret/pattern filtering.
- **W04** \`SourceRegistry\`: versioned artifacts and CURRENT/SUPERSEDED/INVALID/STALE lifecycle.
- **W07** \`KnowledgeRetrievalEngine\`: hybrid lexical/vector retrieval with visibility enforced before scoring; default CURRENT-only and optional source/deployment-SHA filtering.
- **W12** \`AgentOrchestrator\` + \`ToolRegistry\`: orchestration and visibility/verification controls; production-capable tools are explicitly injected and disabled by default.

Rather than rewrite these components, a new test \`integrations/github/test/real-pipeline.test.ts\` composes their **real implementations**. Only its GitHub API client and documents are synthetic.

## Verified acceptance tests

1. Two synthetic approved repositories analogous to public PieCloak and MaceGuard index READMEs with visibility PUBLIC, while staff code remains STAFF and an .env file is not indexed.
2. When a README changes, the W04 registry supersedes the old artifact and W07 drops it from default CURRENT search; explicit history mode retains flagged historical evidence.
3. A GitHub README is **not** assumed to be production code. W07 production-mode retrieval returns zero results when deployed SHA is missing/mismatched and returns the documented chunk only for an **explicitly matching, externally verified deployed SHA**.

The tests intentionally use W07's deterministic **test-only** hashing embeddings, not a production embedding model, and fixed in-memory SQLite stores. They do not claim semantic search quality or a live deployment.

## Validation

On the owner's separate Windows test checkout, after fast-forwarding the isolated branch:

- Real W08/W04/W07 composition: **3/3 passed**.
- Full Vitest suite: **1,145 passing; 1 pre-existing smoke test skipped**.
- Root TypeScript type-check \`tsc --noEmit -p tsconfig.json\`: **passed**.
- Targeted ESLint on new test: **passed**.
- Git working tree clean at this milestone.

## Before production use

- Add an operator-approved, public-first repository registry with one authoritative source-visibility review per repo/file. No arbitrary user/model repo URLs.
- Choose a runtime-only read-only GitHub token or appropriately authenticated service for W08 indexing; never persist tokens to source, logs, prompts, test fixtures, or Discord.
- Provide a production embedding adapter/model and bounded retriever cache. Test-only hashing embeddings cannot be reused for production.
- Expose \`knowledge.search\` as a typed, public read-only tool in W12 **only when a trusted index is initialized and freshness is proven**. Callers cannot set arbitrary history or downgrade visibility. Cite source locator, commit, status, observed timestamp and limit.
- Preserve GitHub **documented behavior** versus current deployed-JAR **actual behavior**, requiring deployment identity from issue #41 where applicable.
- Design answer synthesis to avoid passing full arbitrary README text directly to an unconstrained model. Use extracted, relevant, bounded evidence with prompt-injection separation and deterministic claim checking. Zero or stale evidence means **unverified**.
- Add regression for cross-repo ambiguity, malicious repository content, stale index after GitHub rate limit, withdrawn/invalid docs, changed HEAD during indexing, true deployment mismatch, and permissions.
- Separately design read-only live \`server.runtime_health\` with freshness, source identity and aggregate TPS/MSPT/network/system metrics where supported. **No current metrics provider is connected.** Old audit mentions of Plan unavailable are dated evidence, not a present-tense assertion.
- Draft PR #118 remains HOLD; no production merge, no private tools or server writes.

**Owner action:** none for this isolated proof. A future live diagnostics provider or production source authorization requires a separate owner decision before enabling it.
