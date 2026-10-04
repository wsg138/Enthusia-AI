/**
 * @enthusia/integration-github — GitHub API client (W08).
 *
 * Ingestion is API-only (no clones): the Git Data API pattern
 * (ref -> recursive tree -> blobs) plus REST for repository metadata and
 * issues/PRs. This keeps the indexer stateless and avoids executing any
 * repository content.
 *
 * Authentication: a token from the indexer config is sent as a Bearer
 * Authorization header. The token is NEVER logged, NEVER included in
 * error messages, and NEVER persisted. Error paths scrub it explicitly.
 *
 * Spec: MASTER-SPECIFICATION.md §§16.1, 23, 34.1; WORKER-EXECUTION-PLAN.md §11.
 */

const GITHUB_API_BASE = 'https://api.github.com';

/** A single entry in a (possibly recursive) git tree. */
export interface GitTreeEntry {
  path: string;
  /** 'blob' for files, 'tree' for directories. */
  type: 'blob' | 'tree';
  /** Git object SHA of the entry (blob SHA for files). */
  sha: string;
  /** Blob size in bytes when reported by the API. */
  size?: number;
}

/** Blob content as returned by the Git Data API. */
export interface GitBlob {
  sha: string;
  /** Raw file bytes, base64-encoded by the API. */
  contentBase64: string;
  size: number;
}

/** Repository metadata needed by the indexer. */
export interface GitHubRepoMeta {
  owner: string;
  repo: string;
  defaultBranch: string;
  /** True when the repository is public. */
  isPublic: boolean;
}

/** Issue/PR metadata (bodies only — never code, never secrets). */
export interface GitHubDiscussion {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
}

/**
 * The GitHub surface the indexer needs. Implementations must not perform
 * real network I/O in tests — use the in-test `MockGitHubApi` fixture.
 */
export interface GitHubApi {
  getRepoMeta(owner: string, repo: string): Promise<GitHubRepoMeta>;
  /** Resolve `refs/heads/<branch>` to a commit SHA. */
  getBranchHeadSha(owner: string, repo: string, branch: string): Promise<string>;
  /** Recursive tree for a commit SHA (blob entries carry their SHAs). */
  getRecursiveTree(owner: string, repo: string, commitSha: string): Promise<GitTreeEntry[]>;
  /** Fetch a single blob's content. */
  getBlob(owner: string, repo: string, blobSha: string): Promise<GitBlob>;
  listIssues(owner: string, repo: string): Promise<GitHubDiscussion[]>;
  listPullRequests(owner: string, repo: string): Promise<GitHubDiscussion[]>;
}

/** Error that never carries credential material. */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly endpoint: string;

  constructor(status: number, endpoint: string, detail: string) {
    super(`github api ${status} ${endpoint}: ${detail}`);
    this.name = 'GitHubApiError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

interface RestClientOptions {
  token: string;
  userAgent: string;
  /** Overridable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request wall-clock bound. Default 10 seconds. */
  requestTimeoutMs?: number;
}

/**
 * Authenticated REST + Git Data API client.
 *
 * The token is held in a private field, attached to the Authorization
 * header per request, and scrubbed from every error path. If you add a
 * new request path to this class, do NOT interpolate the token into any
 * message, URL, or log line.
 */
export class RestGitHubClient implements GitHubApi {
  private readonly token: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: RestClientOptions) {
    if (options.token.length === 0) {
      throw new Error('github client: token must not be empty');
    }
    this.token = options.token;
    this.userAgent = options.userAgent;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error('github client: requestTimeoutMs must be a positive integer');
    }
  }

  private async request<T>(method: string, path: string): Promise<T> {
    const url = `${GITHUB_API_BASE}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': this.userAgent,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      // Network-level failure: never echo request details that could
      // carry the header value.
      throw new GitHubApiError(0, path, 'network failure or timeout');
    }
    if (!response.ok) {
      const detail = await safeErrorDetail(response, this.token);
      throw new GitHubApiError(response.status, path, detail);
    }
    return (await response.json()) as T;
  }

  async getRepoMeta(owner: string, repo: string): Promise<GitHubRepoMeta> {
    const data = await this.request<{
      default_branch: string;
      private: boolean;
    }>('GET', `/repos/${owner}/${repo}`);
    return {
      owner,
      repo,
      defaultBranch: data.default_branch,
      isPublic: !data.private,
    };
  }

  async getBranchHeadSha(owner: string, repo: string, branch: string): Promise<string> {
    const data = await this.request<{ object: { sha: string } }>(
      'GET',
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return data.object.sha;
  }

  async getRecursiveTree(owner: string, repo: string, commitSha: string): Promise<GitTreeEntry[]> {
    const data = await this.request<{
      tree: Array<{ path?: string; type?: string; sha?: string; size?: number }>;
      truncated?: boolean;
    }>('GET', `/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`);
    if (data.truncated === true) {
      throw new GitHubApiError(
        200,
        `/repos/${owner}/${repo}/git/trees`,
        'recursive tree response was truncated; refusing partial index',
      );
    }
    const entries: GitTreeEntry[] = [];
    for (const item of data.tree) {
      if (item.path === undefined || item.sha === undefined) continue;
      if (item.type !== 'blob' && item.type !== 'tree') continue;
      const entry: GitTreeEntry = {
        path: item.path,
        type: item.type,
        sha: item.sha,
      };
      if (item.size !== undefined) entry.size = item.size;
      entries.push(entry);
    }
    return entries;
  }

  async getBlob(owner: string, repo: string, blobSha: string): Promise<GitBlob> {
    const data = await this.request<{ sha: string; content: string; size: number }>(
      'GET',
      `/repos/${owner}/${repo}/git/blobs/${blobSha}`,
    );
    return {
      sha: data.sha,
      contentBase64: data.content.replace(/\s/g, ''),
      size: data.size,
    };
  }

  async listIssues(owner: string, repo: string): Promise<GitHubDiscussion[]> {
    const data = await this.listPaged<GitHubIssuePayload>(
      `/repos/${owner}/${repo}/issues?state=all&per_page=100`,
    );
    return data.filter((i) => i.pull_request === undefined).map(toDiscussion);
  }

  async listPullRequests(owner: string, repo: string): Promise<GitHubDiscussion[]> {
    const data = await this.listPaged<GitHubPullPayload>(
      `/repos/${owner}/${repo}/pulls?state=all&per_page=100`,
    );
    return data.map(toDiscussion);
  }

  private async listPaged<T>(basePath: string): Promise<T[]> {
    const rows: T[] = [];
    const separator = basePath.includes('?') ? '&' : '?';
    for (let page = 1; page <= 20; page += 1) {
      const batch = await this.request<T[]>('GET', `${basePath}${separator}page=${page}`);
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    throw new GitHubApiError(0, basePath, 'pagination exceeded 20-page safety bound');
  }
}

interface GitHubIssuePayload {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  user?: { login?: string } | null;
  created_at: string;
  updated_at: string;
  labels?: Array<{ name?: string }>;
  pull_request?: unknown;
}

interface GitHubPullPayload {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  user?: { login?: string } | null;
  created_at: string;
  updated_at: string;
  labels?: Array<{ name?: string }>;
}

function toDiscussion(
  item: GitHubIssuePayload | GitHubPullPayload,
): GitHubDiscussion {
  return {
    number: item.number,
    title: item.title ?? '',
    body: item.body ?? '',
    state: item.state === 'open' ? 'open' : 'closed',
    author: item.user?.login ?? 'unknown',
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    labels: (item.labels ?? []).map((l) => l.name ?? '').filter((n) => n.length > 0),
  };
}

async function safeErrorDetail(response: Response, token: string): Promise<string> {
  try {
    const text = await response.text();
    // Keep the detail short; the API never echoes our Authorization
    // header, but truncate defensively anyway.
    return text.replaceAll(token, '[redacted]').slice(0, 300);
  } catch {
    return 'unreadable error body';
  }
}
