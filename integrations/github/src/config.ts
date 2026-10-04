/**
 * @enthusia/integration-github — repository registry configuration (W08).
 *
 * Which GitHub repositories are approved for indexing, and how each one is
 * indexed. The registry is the allowlist: a repository is NEVER indexed
 * unless it appears here explicitly.
 *
 * The API token comes from configuration only (the `GITHUB_TOKEN`
 * environment variable or an explicit `token` field). It is never logged,
 * never embedded in artifacts, and never passed to the model.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 16.1, 34.1; WORKER-EXECUTION-PLAN.md §11.
 */

import { z } from 'zod';
import { Visibility } from '@enthusia/contracts';

const visibilitySchema = z.nativeEnum(Visibility);

const approvedRepoSchema = z.object({
  /** Repository owner (GitHub org or user), e.g. 'wsg138'. */
  owner: z.string().min(1).max(100),
  /** Repository name, e.g. 'EnthusiaStaff'. */
  repo: z.string().min(1).max(100),
  /** Branch to index. Defaults to the repository's default branch. */
  branch: z.string().min(1).max(200).optional(),
  /**
   * Visibility for indexed source code and configs. Defaults to STAFF:
   * source may live in a private repo or describe internals.
   */
  codeVisibility: visibilitySchema.optional(),
  /**
   * Visibility for docs (README, markdown). Defaults to STAFF as well —
   * the operator may relax it to PUBLIC for known-public repos.
   */
  docsVisibility: visibilitySchema.optional(),
  /** Visibility for issue/PR metadata. Defaults to STAFF independently of source-code visibility. */
  discussionVisibility: visibilitySchema.optional(),
  /** Index issue titles/bodies as metadata artifacts. Default false. */
  indexIssues: z.boolean().optional(),
  /** Index PR titles/bodies as metadata artifacts. Default false. */
  indexPullRequests: z.boolean().optional(),
  /** Per-repo file-size cap in bytes. Falls back to the global default. */
  maxFileBytes: z.number().int().positive().optional(),
  /** Extra path prefixes to include (in addition to the built-in kinds). */
  includePaths: z.array(z.string().min(1)).optional(),
  /** Path prefixes to exclude, e.g. ['generated/']. */
  excludePaths: z.array(z.string().min(1)).optional(),
});

const indexerConfigSchema = z.object({
  /**
   * GitHub API token. Prefer leaving this unset and exporting
   * GITHUB_TOKEN; an explicit value here is accepted for managed
   * deployments (secret manager -> env -> config).
   */
  token: z.string().min(1).optional(),
  /** Approved repositories. Empty = nothing is indexed. */
  repos: z.array(approvedRepoSchema).min(0),
  /** Global per-file size cap in bytes. Default 1 MiB. */
  maxFileBytes: z.number().int().positive().default(1024 * 1024),
  /** HTTP user agent for GitHub API calls. */
  userAgent: z.string().min(1).default('enthusia-ai-github-indexer/1.0'),
});

export type ApprovedRepo = z.infer<typeof approvedRepoSchema>;
export type GitHubIndexerConfigInput = z.input<typeof indexerConfigSchema>;

/** Validated, runtime-ready indexer configuration. */
export interface GitHubIndexerConfig {
  /** API token — treat as a secret: never log, never persist. */
  token: string;
  repos: ResolvedApprovedRepo[];
  maxFileBytes: number;
  userAgent: string;
}

/** An approved repo with all defaults resolved. */
export interface ResolvedApprovedRepo {
  owner: string;
  repo: string;
  branch?: string | undefined;
  codeVisibility: Visibility;
  docsVisibility: Visibility;
  discussionVisibility?: Visibility;
  indexIssues: boolean;
  indexPullRequests: boolean;
  maxFileBytes?: number | undefined;
  includePaths: string[];
  excludePaths: string[];
}

const TOKEN_ENV_VAR = 'GITHUB_TOKEN';

/**
 * Validate raw configuration and resolve the token + defaults.
 * The token is read from `input.token` or the GITHUB_TOKEN environment
 * variable. Throws when no token is available — the indexer refuses to
 * run unauthenticated (rate limits, no private-repo access, no audit).
 */
export function loadGitHubIndexerConfig(input: GitHubIndexerConfigInput): GitHubIndexerConfig {
  const parsed = indexerConfigSchema.parse(input);
  const token = parsed.token ?? process.env[TOKEN_ENV_VAR];
  if (token === undefined || token.length === 0) {
    throw new Error(
      `github indexer: no API token configured (set ${TOKEN_ENV_VAR} or pass token in config)`,
    );
  }
  const repos: ResolvedApprovedRepo[] = parsed.repos.map((r) => ({
    owner: r.owner,
    repo: r.repo,
    branch: r.branch,
    codeVisibility: r.codeVisibility ?? Visibility.STAFF,
    docsVisibility: r.docsVisibility ?? Visibility.STAFF,
    discussionVisibility: r.discussionVisibility ?? Visibility.STAFF,
    indexIssues: r.indexIssues ?? false,
    indexPullRequests: r.indexPullRequests ?? false,
    maxFileBytes: r.maxFileBytes,
    includePaths: r.includePaths ?? [],
    excludePaths: r.excludePaths ?? [],
  }));
  return {
    token,
    repos,
    maxFileBytes: parsed.maxFileBytes,
    userAgent: parsed.userAgent,
  };
}

/** `owner/repo` identity string used in logs and locators. */
export function repoIdentity(repo: Pick<ApprovedRepo, 'owner' | 'repo'>): string {
  return `${repo.owner}/${repo.repo}`;
}
