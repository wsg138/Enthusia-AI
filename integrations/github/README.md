# @enthusia/integration-github — GitHub repository indexer (W08)

Incremental indexing of approved GitHub repositories into the Enthusia AI
knowledge system.

Spec: `MASTER-SPECIFICATION.md` §§12, 23 · `WORKER-EXECUTION-PLAN.md` §11.

## What it does

For every repository in the **approved-repo registry** (`src/config.ts`):

1. Resolves the branch head commit SHA via the Git Data API (no clones —
   the indexer never executes repository content).
2. Fetches the recursive tree: every file's **blob SHA**, no content yet.
3. Compares each blob SHA against the artifact currently registered for its
   locator (`github:<owner>/<repo>:<path>`). Unchanged SHA → skip: no blob
   fetch, no parse, no re-index.
4. Changed/new file → fetch blob → binary/size/secret pre-scan → parse →
   register with the source registry → chunk + index the text.
5. Files that vanished from the tree → marked `INVALID` (history kept).
6. Issues/PRs (when enabled per repo) → metadata artifacts, versioned by
   `updatedAt` so edits supersede.
7. Derived entity relationships (repo → plugin → commands → permissions,
   file → SHA) → run report **and** an indexed per-repo summary artifact.

## Wiring: W04 + W07 (not vendored here)

This package drives — but does not contain — two other workstreams:

| Dependency | Workstream | Used as |
|---|---|---|
| `SourceRegistry` (`packages/source-provenance`) | W04 (PR #4) | artifact lifecycle: `register` with atomic supersession (`CREATED` / `UNCHANGED` / `SUPERSEDED`), `getCurrent`, `listCurrent`, `markInvalid` |
| `KnowledgeRetrievalEngine` (`services/knowledge-indexer`) | W07 (PR #12) | `indexArtifactText(artifact, status, text, chunker)`, `updateArtifactStatus(artifactId, status)` |

`src/ports.ts` declares structural ports that mirror those public APIs
exactly. The real classes satisfy the ports with **no adapter**; compose
them at the service boundary once PRs #4 and #12 merge:

```ts
import { SourceRegistry } from '@enthusia/source-provenance';
import { KnowledgeRetrievalEngine } from '@enthusia/knowledge-indexer';
import { GitHubIndexer, RestGitHubClient } from '@enthusia/integration-github';

const indexer = new GitHubIndexer(config, {
  client: new RestGitHubClient({ token, userAgent: config.userAgent }),
  registry: new SourceRegistry(store),
  retrieval: new KnowledgeRetrievalEngine({ ..., defaultChunker }),
});
```

Until then, `test/fakes.ts` provides in-test doubles replicating the
W04/W07 semantics. **Do not modify W04/W07 code from this package.**

## Configuration

```ts
const indexer = new GitHubIndexer(
  {
    token: process.env.GITHUB_TOKEN, // or explicit; never logged
    repos: [
      {
        owner: 'wsg138',
        repo: 'EnthusiaStaff',
        branch: 'main',               // default: repo default branch
        codeVisibility: Visibility.STAFF,  // default STAFF
        docsVisibility: Visibility.PUBLIC, // default STAFF
        indexIssues: true,            // default false
        indexPullRequests: false,     // default false
        excludePaths: ['generated/'],
      },
    ],
    maxFileBytes: 1024 * 1024,
  },
  deps,
);
await indexer.indexAll();
```

A repository is **never** indexed unless it appears in `repos`.

## Safety properties

- **Token**: from config/env only; sent as a Bearer header; scrubbed from
  every error path (`RestGitHubClient` throws `GitHubApiError`, which never
  carries credential material). Never persisted, never embedded in artifacts.
- **Secrets**: files matching secret patterns (private keys, `ghp_`/`gho_`
  tokens, `xox*` tokens, AWS keys, `sk-*` keys, quoted credential
  assignments) are skipped **before** indexing and never registered.
  Binary files, oversize files, `.env*`, lockfiles, and key files are
  skipped too.
- **Visibility**: code/configs default to `STAFF`; docs default to `STAFF`
  unless the operator explicitly relaxes them. `SECRET_DENY` is never
  produced.
- **Deployment state** (spec §31): every artifact records `branch`,
  `commitSha`, `blobSha`, and `deploymentState: 'git-main'`. Git main is
  **never** labeled as deployed/production — that claim requires
  deployment evidence this indexer does not have.

## Incremental model

- **Commit fast path**: unchanged branch head SHA → whole repo skipped
  (disabled automatically when issues/PRs are tracked, since those live
  outside the git tree).
- **Per-file SHA compare**: the tree yields blob SHAs, so unchanged files
  cost zero blob fetches even on a cold start.
- **Negative skip cache**: secret-suspect/oversize files are never
  registered, so their skip decision is cached per (locator, blob SHA) for
  the indexer instance lifetime; a changed file is always re-examined.
- **Supersession**: changed file → registry atomically supersedes the old
  artifact (`SUPERSEDED`, history kept) and the new artifact's chunks are
  indexed as `CURRENT`; the old artifact's chunks are flipped to
  `SUPERSEDED` via `updateArtifactStatus`, so current-only retrieval drops
  them without a re-index.
- **Deletions**: files known to the registry but absent from the tree are
  marked `INVALID`; their chunks follow.

## Parsers (`src/parsers.ts`)

- **Manifests**: `plugin.yml`, `paper-plugin.yml`, `bungeecord.yml`,
  `velocity-plugin.json`, `plugin.json` → commands + permissions parsed
  with a deliberate YAML-subset parser, rendered as a summary plus raw
  text for exact key search.
- **Code**: `.java/.kt/.ts/.js/.py/.go/.rs/.lua/.sql/...` → raw text with
  a `# symbols:` header of regex-extracted class/function names
  (MVP per plan; no AST, no execution).
- **Docs**: markdown/text → raw text. **Configs**: raw text.

## Limitations (MVP)

- The commit-SHA cache and skip cache are in-memory; a restarted indexer
  re-fetches the tree (but per-file SHA comparison still prevents
  re-indexing unchanged content).
- Symbol extraction is regex-based; exotic declarations may be missed.
- No webhook support yet — reconciliation is poll-driven (spec §12.3).

## Tests

```sh
npx vitest run integrations/github
```

18 tests, all with `MockGitHubApi` fixtures — **no real GitHub API calls**.
Covers: initial index, relationship derivation, unchanged-SHA skip (no new
blob fetches), the acceptance scenario (changed commit → old artifact
`SUPERSEDED`, new `CURRENT`, stale chunks flipped), deletions →
`INVALID`, issue metadata + supersession on edit, config validation, token
redaction in errors, and parser unit tests.
