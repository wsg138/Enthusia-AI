/**
 * @enthusia/integration-github — GitHub repository indexer (W08).
 *
 * Incremental indexing of approved GitHub repositories into the knowledge
 * system, per MASTER-SPECIFICATION.md §§12, 23 and WORKER-EXECUTION-PLAN.md
 * §11.
 *
 * Pipeline per approved repository:
 *
 *   1. Resolve the branch head commit SHA (Git Data API, no clones).
 *   2. Fetch the recursive tree — every file's blob SHA, no content yet.
 *   3. For each indexable file: compare the blob SHA against the artifact
 *      currently registered for its locator (`github:<owner>/<repo>:<path>`).
 *      Unchanged SHA -> skip (no blob fetch, no re-parse).
 *   4. Changed/new file -> fetch blob, secret/binary/size pre-scan, parse,
 *      register with the W04 source registry (atomic supersession:
 *      old artifact -> SUPERSEDED, new -> CURRENT), then index the parsed
 *      text with the W07 retrieval engine and propagate the supersession
 *      to the old artifact's chunks.
 *   5. Files that vanished from the tree -> mark INVALID (history kept).
 *   6. Issues/PRs (when enabled) -> metadata artifacts.
 *   7. Derived entity relationships (repo -> plugin -> commands ->
 *      permissions) -> run report + indexed summary artifact.
 *
 * Current-production caution (§31): artifacts record the branch and commit
 * SHA they were indexed from and are marked `deploymentState: 'git-main'`.
 * Git main is NEVER labeled as deployed/production — that claim requires
 * deployment evidence this indexer does not have.
 *
 * The indexer is injected with its collaborators (GitHub API client,
 * artifact registry, retrieval engine) and performs no network I/O
 * itself, which makes it fully testable with fixtures.
 */

import {
  SourceStatus,
  SourceType,
  Visibility,
  type SourceArtifact,
} from '@enthusia/contracts';
import {
  loadGitHubIndexerConfig,
  repoIdentity,
  type ApprovedRepo,
  type GitHubIndexerConfig,
  type GitHubIndexerConfigInput,
  type ResolvedApprovedRepo,
} from './config.js';
import {
  type GitBlob,
  type GitHubApi,
  type GitHubDiscussion,
  type GitTreeEntry,
} from './github-client.js';
import {
  classifyPath,
  isSkipped,
  parseFile,
  type SkipReason,
} from './parsers.js';
import {
  commandEntityId,
  fileEntityId,
  permissionEntityId,
  pluginEntityId,
  relationshipsForManifest,
  renderRelationshipsText,
  repoEntityId,
  type EntityRelationship,
} from './relationships.js';
import {
  type ArtifactRegistryPort,
  type IndexedChunk,
  type RegisterArtifactInput,
  type RetrievalEnginePort,
  type StoredArtifact,
  type TextChunker,
} from './ports.js';

/** Component name recorded on every artifact this indexer registers. */
export const GITHUB_INDEXER_COMPONENT = 'github-indexer';
/** Parser version stamped on artifacts (bump when parsing changes). */
export const GITHUB_INDEXER_PARSER_VERSION = 'github-indexer/1.0';
/** Deployment-state marker: git main, NOT production (spec §31). */
export const DEPLOYMENT_STATE_GIT_MAIN = 'git-main';

export interface IndexerDeps {
  client: GitHubApi;
  registry: ArtifactRegistryPort;
  retrieval: RetrievalEnginePort;
  /** Chunker passed through to `indexArtifactText`. Defaults to a built-in. */
  chunker?: TextChunker;
  /** Clock for timestamps; defaults to the real clock. */
  clock?: () => string;
}

export interface SkippedFile {
  path: string;
  reason: SkipReason;
  detail: string;
}

export interface RepoIndexReport {
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  /** True when the branch head SHA was unchanged and nothing was done. */
  repoUnchanged: boolean;
  filesSeen: number;
  filesIndexed: number;
  filesSkipped: number;
  filesUnchanged: number;
  filesInvalidated: number;
  artifactsCreated: number;
  artifactsUnchanged: number;
  artifactsSuperseded: number;
  chunksIndexed: number;
  issuesIndexed: number;
  pullRequestsIndexed: number;
  relationships: EntityRelationship[];
  skipped: SkippedFile[];
  errors: string[];
}

function emptyReport(
  repo: ResolvedApprovedRepo,
  branch: string,
  commitSha: string,
): RepoIndexReport {
  return {
    owner: repo.owner,
    repo: repo.repo,
    branch,
    commitSha,
    repoUnchanged: false,
    filesSeen: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesUnchanged: 0,
    filesInvalidated: 0,
    artifactsCreated: 0,
    artifactsUnchanged: 0,
    artifactsSuperseded: 0,
    chunksIndexed: 0,
    issuesIndexed: 0,
    pullRequestsIndexed: 0,
    relationships: [],
    skipped: [],
    errors: [],
  };
}

/**
 * Deterministic sentence-ish chunker used when no W07 chunker is
 * injected. Splits on blank lines with a character cap; the real
 * deployment injects W07's FixedWindowChunker/MarkdownSectionChunker.
 */
class FallbackChunker implements TextChunker {
  readonly name = 'github-indexer-fallback';
  private readonly maxChars: number;

  constructor(maxChars = 1500) {
    this.maxChars = maxChars;
  }

  chunk(text: string): { text: string; charStart: number; charEnd: number }[] {
    const cuts: { text: string; charStart: number; charEnd: number }[] = [];
    const paragraphs = text.split(/\n{2,}/);
    let offset = 0;
    let current = '';
    let currentStart = 0;
    const flush = (end: number): void => {
      if (current.length > 0) {
        cuts.push({ text: current, charStart: currentStart, charEnd: end });
        current = '';
      }
    };
    for (const para of paragraphs) {
      const start = text.indexOf(para, offset);
      if (current.length > 0 && current.length + para.length + 2 > this.maxChars) {
        flush(start);
        currentStart = start;
      } else if (current.length === 0) {
        currentStart = start;
      }
      current += (current.length > 0 ? '\n\n' : '') + para;
      offset = start + para.length;
      if (current.length >= this.maxChars) {
        flush(offset);
        currentStart = offset;
      }
    }
    flush(text.length);
    return cuts;
  }
}

const nowIso = (): string => new Date().toISOString();

export class GitHubIndexer {
  private readonly config: GitHubIndexerConfig;
  private readonly client: GitHubApi;
  private readonly registry: ArtifactRegistryPort;
  private readonly retrieval: RetrievalEnginePort;
  private readonly chunker: TextChunker;
  private readonly clock: () => string;
  /** Last indexed commit SHA per `owner/repo` (in-memory; see README). */
  private readonly lastCommitSha = new Map<string, string>();
  /**
   * Negative skip cache: locator -> blob SHA that was already examined
   * and skipped. Secret-suspect and oversize files are never registered,
   * so without this they would be re-fetched on every run. Keyed by blob
   * SHA: a changed file is re-examined.
   */
  private readonly skipCache = new Map<string, { sha: string; reason: SkipReason; detail: string }>();

  constructor(configInput: GitHubIndexerConfigInput, deps: IndexerDeps) {
    this.config = loadGitHubIndexerConfig(configInput);
    this.client = deps.client;
    this.registry = deps.registry;
    this.retrieval = deps.retrieval;
    this.chunker = deps.chunker ?? new FallbackChunker();
    this.clock = deps.clock ?? nowIso;
  }

  /** Index every approved repository, sequentially (rate-limit friendly). */
  async indexAll(): Promise<RepoIndexReport[]> {
    const reports: RepoIndexReport[] = [];
    for (const repo of this.config.repos) {
      reports.push(await this.indexRepo(repo));
    }
    return reports;
  }

  /** Index a single approved repository. */
  async indexRepo(repo: ResolvedApprovedRepo): Promise<RepoIndexReport> {
    const repoId = repoIdentity(repo);
    let meta;
    let branch: string;
    let commitSha: string;
    let tree: GitTreeEntry[];
    try {
      meta = await this.client.getRepoMeta(repo.owner, repo.repo);
      branch = repo.branch ?? meta.defaultBranch;
      commitSha = await this.client.getBranchHeadSha(repo.owner, repo.repo, branch);
      tree = await this.client.getRecursiveTree(repo.owner, repo.repo, commitSha);
    } catch (error) {
      await this.markRepoStale(repo);
      throw error;
    }
    const report = emptyReport(repo, branch, commitSha);

    // Commit-level fast path: the whole tree is unchanged. Issues/PRs
    // live outside the git tree, so the fast path is only valid when
    // they are not being tracked — otherwise their updates would be
    // missed until the next commit.
    if (
      !repo.indexIssues &&
      !repo.indexPullRequests &&
      this.lastCommitSha.get(repoId) === commitSha
    ) {
      report.repoUnchanged = true;
      return report;
    }

    const blobs = tree.filter((e) => e.type === 'blob');
    report.filesSeen = blobs.length;

    const seenLocators = new Set<string>();

    for (const entry of blobs) {
      try {
        await this.indexTreeEntry(repo, branch, commitSha, entry, report, seenLocators);
      } catch (error) {
        report.errors.push(`${entry.path}: ${(error as Error).message}`);
        await this.markLocatorStale(fileEntityId(repo.owner, repo.repo, entry.path), report);
      }
    }

    await this.invalidateDeleted(repo, seenLocators, report);
    const relationshipsComplete = await this.buildRelationshipSnapshot(repo, tree, report);

    if (repo.indexIssues) {
      report.issuesIndexed = await this.indexDiscussions(
        repo,
        branch,
        commitSha,
        'issues',
        () => this.client.listIssues(repo.owner, repo.repo),
        report,
      );
    }
    if (repo.indexPullRequests) {
      report.pullRequestsIndexed = await this.indexDiscussions(
        repo,
        branch,
        commitSha,
        'pulls',
        () => this.client.listPullRequests(repo.owner, repo.repo),
        report,
      );
    }

    if (relationshipsComplete) {
      await this.indexRelationshipSummary(repo, branch, commitSha, report);
    } else {
      await this.markLocatorStale(
        `${repoEntityId(repo.owner, repo.repo)}:__relationships__`,
        report,
      );
    }

    if (report.errors.length === 0) {
      this.lastCommitSha.set(repoId, commitSha);
    }
    return report;
  }

  // ------------------------------------------------------------------ files

  private async indexTreeEntry(
    repo: ResolvedApprovedRepo,
    branch: string,
    commitSha: string,
    entry: GitTreeEntry,
    report: RepoIndexReport,
    seenLocators: Set<string>,
  ): Promise<void> {
    const path = entry.path;
    const maxBytes = repo.maxFileBytes ?? this.config.maxFileBytes;

    if (isExcludedPath(repo, path)) {
      this.recordSkip(report, path, 'excluded-path', 'matched repo excludePaths');
      return;
    }

    const kind = classifyPath(path);
    if (kind === 'skip') {
      this.recordSkip(report, path, 'unsupported-kind', 'no parser for this path');
      return;
    }

    const locator = fileEntityId(repo.owner, repo.repo, path);
    seenLocators.add(locator);

    // Incremental core: the tree already gives us the blob SHA, so an
    // unchanged file never costs a blob fetch, a parse, or a re-index.
    const current = this.registry.getCurrent(locator);
    if (current !== undefined && current.version === entry.sha) {
      if (current.status === SourceStatus.STALE) {
        const refreshed = this.registry.revalidate(current.artifactId, this.clock());
        await this.retrieval.updateArtifactStatus(refreshed.artifactId, SourceStatus.CURRENT);
      }
      report.filesUnchanged += 1;
      report.artifactsUnchanged += 1;
      return;
    }

    // Negative cache: secret-suspect / oversize files are never
    // registered, so without this they would be re-fetched every run.
    const cachedSkip = this.skipCache.get(locator);
    if (cachedSkip !== undefined && cachedSkip.sha === entry.sha) {
      this.recordSkip(report, path, cachedSkip.reason, cachedSkip.detail);
      if (current !== undefined) await this.markArtifactStale(current, report);
      return;
    }

    if (entry.size !== undefined && entry.size > maxBytes) {
      this.recordSkip(report, path, 'too-large', `tree reports ${entry.size} bytes`, {
        locator,
        sha: entry.sha,
      });
      if (current !== undefined) await this.markArtifactStale(current, report);
      return;
    }

    const blob = await this.client.getBlob(repo.owner, repo.repo, entry.sha);
    const text = decodeBlob(blob);

    const parsed = parseFile(path, text, { maxBytes, repoId: repoIdentity(repo) });
    if (isSkipped(parsed)) {
      this.recordSkip(report, path, parsed.reason, parsed.detail, { locator, sha: entry.sha });
      if (current !== undefined) await this.markArtifactStale(current, report);
      return;
    }

    const visibility = parsed.kind === 'doc' ? repo.docsVisibility : repo.codeVisibility;
    const input: RegisterArtifactInput = {
      sourceType: SourceType.GITHUB,
      sourceLocator: locator,
      component: GITHUB_INDEXER_COMPONENT,
      authority: repoEntityId(repo.owner, repo.repo),
      version: entry.sha,
      observedTime: this.clock(),
      visibility,
      contentMetadata: {
        contentType: parsed.contentType,
        title: path,
        sizeBytes: text.length,
        extra: {
          branch,
          commitSha,
          blobSha: entry.sha,
          // Spec §31: git main is NOT production. This marker must be
          // present so no consumer mistakes the source for a deployment.
          deploymentState: DEPLOYMENT_STATE_GIT_MAIN,
          fileKind: parsed.kind,
          symbols: parsed.symbols.map((s) => `${s.kind}:${s.name}`),
        },
      },
      parserVersion: GITHUB_INDEXER_PARSER_VERSION,
    };

    const result = this.registry.register(input);
    report.filesIndexed += 1;
    report.relationships.push({
      type: 'FILE_HAS_SHA',
      from: locator,
      to: `sha:${entry.sha}`,
    });

    // Chunk + index the new/changed artifact as CURRENT.
    const chunks = await this.retrieval.indexArtifactText(
      result.artifact,
      SourceStatus.CURRENT,
      parsed.text,
      this.chunker,
    );
    report.chunksIndexed += chunks.length;

    switch (result.outcome) {
      case 'CREATED':
        report.artifactsCreated += 1;
        break;
      case 'UNCHANGED':
        // Raced with the pre-check (or an out-of-band write); treat as unchanged.
        report.artifactsUnchanged += 1;
        break;
      case 'SUPERSEDED': {
        report.artifactsSuperseded += 1;
        // Propagate the lifecycle change so the old artifact's chunks
        // leave current retrieval without a full re-index.
        const supersededId = result.supersededArtifactId;
        if (supersededId !== undefined) {
          await this.retrieval.updateArtifactStatus(supersededId, SourceStatus.SUPERSEDED);
        }
        break;
      }
    }

    if (parsed.manifest !== undefined) {
      report.relationships.push(...relationshipsForManifest(repo.owner, repo.repo, parsed.manifest));
    }
  }

  /** Files the registry knows about but the tree no longer contains. */
  private async invalidateDeleted(
    repo: ResolvedApprovedRepo,
    seenLocators: Set<string>,
    report: RepoIndexReport,
  ): Promise<void> {
    const prefix = `${repoEntityId(repo.owner, repo.repo)}:`;
    let known: StoredArtifact[];
    try {
      known = this.registry.listCurrent({
        sourceType: SourceType.GITHUB,
        component: GITHUB_INDEXER_COMPONENT,
      });
    } catch {
      // Registry does not support listing (older port); skip deletion
      // detection rather than failing the run.
      return;
    }
    for (const artifact of known) {
      if (!artifact.sourceLocator.startsWith(prefix)) continue;
      const pathPart = artifact.sourceLocator.slice(prefix.length);
      // Only tree files are deletion candidates: discussion metadata
      // (issues/N, pulls/N) and the derived relationship summary are
      // managed by their own flows, not by tree membership.
      if (
        pathPart === '__relationships__' ||
        pathPart.startsWith('issues/') ||
        pathPart.startsWith('pulls/')
      ) {
        continue;
      }
      if (seenLocators.has(artifact.sourceLocator)) continue;
      try {
        this.registry.markInvalid(artifact.artifactId);
        await this.retrieval.updateArtifactStatus(artifact.artifactId, SourceStatus.INVALID);
        report.filesInvalidated += 1;
      } catch (error) {
        report.errors.push(`${artifact.sourceLocator}: ${(error as Error).message}`);
      }
    }
  }

  // ------------------------------------------------------------- discussions

  private async indexDiscussions(
    repo: ResolvedApprovedRepo,
    branch: string,
    commitSha: string,
    kind: 'issues' | 'pulls',
    list: () => Promise<GitHubDiscussion[]>,
    report: RepoIndexReport,
  ): Promise<number> {
    let discussions: GitHubDiscussion[];
    try {
      discussions = await list();
    } catch (error) {
      report.errors.push(`${kind}: ${(error as Error).message}`);
      await this.markDiscussionKindStale(repo, kind, report);
      return 0;
    }
    let indexed = 0;
    for (const discussion of discussions) {
      const locator = `${repoEntityId(repo.owner, repo.repo)}:${kind}/${discussion.number}`;
      // Version changes whenever the discussion is updated -> supersession.
      const version = `${kind}-${discussion.number}-${discussion.updatedAt}`;
      try {
        const current = this.registry.getCurrent(locator);
        if (current !== undefined && current.version === version) {
          if (current.status === SourceStatus.STALE) {
            const refreshed = this.registry.revalidate(current.artifactId, this.clock());
            await this.retrieval.updateArtifactStatus(refreshed.artifactId, SourceStatus.CURRENT);
          }
          report.artifactsUnchanged += 1;
          continue;
        }
        const text = renderDiscussionText(discussion, kind, repo);
        const input: RegisterArtifactInput = {
          sourceType: SourceType.GITHUB,
          sourceLocator: locator,
          component: GITHUB_INDEXER_COMPONENT,
          authority: repoEntityId(repo.owner, repo.repo),
          version,
          observedTime: this.clock(),
          visibility: repo.discussionVisibility ?? Visibility.STAFF,
          contentMetadata: {
            contentType: 'text/discussion',
            title: `${kind.slice(0, -1)} #${discussion.number}: ${discussion.title}`,
            extra: {
              branch,
              commitSha,
              deploymentState: DEPLOYMENT_STATE_GIT_MAIN,
              number: discussion.number,
              state: discussion.state,
            },
          },
          parserVersion: GITHUB_INDEXER_PARSER_VERSION,
        };
        const result = this.registry.register(input);
        const chunks = await this.retrieval.indexArtifactText(
          result.artifact,
          SourceStatus.CURRENT,
          text,
          this.chunker,
        );
        report.chunksIndexed += chunks.length;
        if (result.outcome === 'SUPERSEDED' && result.supersededArtifactId !== undefined) {
          report.artifactsSuperseded += 1;
          await this.retrieval.updateArtifactStatus(
            result.supersededArtifactId,
            SourceStatus.SUPERSEDED,
          );
        } else if (result.outcome === 'CREATED') {
          report.artifactsCreated += 1;
        } else {
          report.artifactsUnchanged += 1;
        }
        indexed += 1;
      } catch (error) {
        report.errors.push(`${locator}: ${(error as Error).message}`);
        await this.markLocatorStale(locator, report);
      }
    }
    return indexed;
  }

  private async markDiscussionKindStale(
    repo: ResolvedApprovedRepo,
    kind: 'issues' | 'pulls',
    report: RepoIndexReport,
  ): Promise<void> {
    const prefix = `${repoEntityId(repo.owner, repo.repo)}:${kind}/`;
    for (const artifact of this.registry.listCurrent({
      sourceType: SourceType.GITHUB,
      component: GITHUB_INDEXER_COMPONENT,
    })) {
      if (artifact.sourceLocator.startsWith(prefix)) {
        await this.markArtifactStale(artifact, report);
      }
    }
  }

  private async markArtifactStale(
    artifact: StoredArtifact,
    report?: RepoIndexReport,
  ): Promise<void> {
    try {
      this.registry.markStale(artifact.artifactId);
      await this.retrieval.updateArtifactStatus(artifact.artifactId, SourceStatus.STALE);
    } catch (error) {
      report?.errors.push(`stale ${artifact.sourceLocator}: ${(error as Error).message}`);
    }
  }

  private async markLocatorStale(locator: string, report?: RepoIndexReport): Promise<void> {
    const artifact = this.registry.getCurrent(locator);
    if (artifact !== undefined && artifact.status === SourceStatus.CURRENT) {
      await this.markArtifactStale(artifact, report);
    }
  }

  private async markRepoStale(repo: ResolvedApprovedRepo): Promise<void> {
    const prefix = `${repoEntityId(repo.owner, repo.repo)}:`;
    const current = this.registry.listCurrent({
      sourceType: SourceType.GITHUB,
      component: GITHUB_INDEXER_COMPONENT,
    });
    for (const artifact of current) {
      if (artifact.sourceLocator.startsWith(prefix)) {
        await this.markArtifactStale(artifact);
      }
    }
  }

  private async buildRelationshipSnapshot(
    repo: ResolvedApprovedRepo,
    tree: GitTreeEntry[],
    report: RepoIndexReport,
  ): Promise<boolean> {
    const relationships: EntityRelationship[] = [];
    let complete = true;
    const maxBytes = repo.maxFileBytes ?? this.config.maxFileBytes;
    for (const entry of tree) {
      if (entry.type !== 'blob' || isExcludedPath(repo, entry.path)) continue;
      const kind = classifyPath(entry.path);
      if (kind === 'skip') continue;
      const locator = fileEntityId(repo.owner, repo.repo, entry.path);
      relationships.push({ type: 'FILE_HAS_SHA', from: locator, to: `sha:${entry.sha}` });
      if (kind !== 'manifest' || (entry.size !== undefined && entry.size > maxBytes)) continue;
      try {
        const blob = await this.client.getBlob(repo.owner, repo.repo, entry.sha);
        const parsed = parseFile(entry.path, decodeBlob(blob), {
          maxBytes,
          repoId: repoIdentity(repo),
        });
        if (!isSkipped(parsed) && parsed.manifest !== undefined) {
          relationships.push(...relationshipsForManifest(repo.owner, repo.repo, parsed.manifest));
        }
      } catch (error) {
        complete = false;
        report.errors.push(`relationships ${entry.path}: ${(error as Error).message}`);
      }
    }
    report.relationships = relationships;
    return complete;
  }

  // ------------------------------------------------------- relationship index

  /**
   * Index the derived entity graph as its own artifact so relationships
   * are retrievable through normal knowledge search, not just visible
   * in run reports.
   */
  private async indexRelationshipSummary(
    repo: ResolvedApprovedRepo,
    branch: string,
    commitSha: string,
    report: RepoIndexReport,
  ): Promise<void> {
    const locator = `${repoEntityId(repo.owner, repo.repo)}:__relationships__`;
    if (report.relationships.length === 0) {
      const current = this.registry.getCurrent(locator);
      if (current !== undefined) {
        this.registry.markInvalid(current.artifactId);
        await this.retrieval.updateArtifactStatus(current.artifactId, SourceStatus.INVALID);
      }
      return;
    }
    const text = [
      `# entity relationships: ${repoIdentity(repo)} @ ${commitSha.slice(0, 12)}`,
      '# derived by the W08 github indexer from plugin manifests',
      '',
      renderRelationshipsText(report.relationships),
    ].join('\n');
    const version = `rels-${stableHexDigest(text).slice(0, 16)}`;
    const current = this.registry.getCurrent(locator);
    if (current !== undefined && current.version === version) {
      if (current.status === SourceStatus.STALE) {
        const refreshed = this.registry.revalidate(current.artifactId, this.clock());
        await this.retrieval.updateArtifactStatus(refreshed.artifactId, SourceStatus.CURRENT);
      }
      report.artifactsUnchanged += 1;
      return;
    }
    const input: RegisterArtifactInput = {
      sourceType: SourceType.GITHUB,
      sourceLocator: locator,
      component: GITHUB_INDEXER_COMPONENT,
      authority: repoEntityId(repo.owner, repo.repo),
      version,
      observedTime: this.clock(),
      visibility: repo.codeVisibility,
      contentMetadata: {
        contentType: 'text/relationships',
        title: `entity relationships for ${repoIdentity(repo)}`,
        extra: {
          branch,
          commitSha,
          deploymentState: DEPLOYMENT_STATE_GIT_MAIN,
          relationshipCount: report.relationships.length,
        },
      },
      parserVersion: GITHUB_INDEXER_PARSER_VERSION,
    };
    const result = this.registry.register(input);
    const chunks = await this.retrieval.indexArtifactText(
      result.artifact,
      SourceStatus.CURRENT,
      text,
      this.chunker,
    );
    report.chunksIndexed += chunks.length;
    if (result.outcome === 'SUPERSEDED' && result.supersededArtifactId !== undefined) {
      report.artifactsSuperseded += 1;
      await this.retrieval.updateArtifactStatus(result.supersededArtifactId, SourceStatus.SUPERSEDED);
    } else if (result.outcome === 'CREATED') {
      report.artifactsCreated += 1;
    } else {
      report.artifactsUnchanged += 1;
    }
  }

  private recordSkip(
    report: RepoIndexReport,
    path: string,
    reason: SkipReason,
    detail: string,
    cacheKey?: { locator: string; sha: string },
  ): void {
    report.filesSkipped += 1;
    report.skipped.push({ path, reason, detail });
    // Cache content-based skips (never registered, so never otherwise
    // remembered) keyed by blob SHA. A changed file is re-examined.
    if (
      cacheKey !== undefined &&
      (reason === 'secret-suspect' || reason === 'too-large' || reason === 'binary')
    ) {
      this.skipCache.set(cacheKey.locator, { sha: cacheKey.sha, reason, detail });
    }
  }
}

function isExcludedPath(repo: ResolvedApprovedRepo, path: string): boolean {
  return repo.excludePaths.some((prefix) => path === prefix || path.startsWith(prefix));
}

function decodeBlob(blob: GitBlob): string {
  try {
    return Buffer.from(blob.contentBase64, 'base64').toString('utf8');
  } catch (error) {
    throw new Error(`blob ${blob.sha} is not valid base64: ${(error as Error).message}`);
  }
}

function renderDiscussionText(
  discussion: GitHubDiscussion,
  kind: 'issues' | 'pulls',
  repo: ResolvedApprovedRepo,
): string {
  const label = kind === 'issues' ? 'issue' : 'pull request';
  const lines = [
    `# ${label} #${discussion.number}: ${discussion.title}`,
    `repo: ${repoIdentity(repo)}`,
    `state: ${discussion.state} | author: @${discussion.author}`,
    `created: ${discussion.createdAt} | updated: ${discussion.updatedAt}`,
  ];
  if (discussion.labels.length > 0) {
    lines.push(`labels: ${discussion.labels.join(', ')}`);
  }
  lines.push('', discussion.body.trim().length > 0 ? discussion.body : '(no body)');
  return lines.join('\n');
}

/**
 * Deterministic non-cryptographic hex digest for derived-artifact
 * versioning (relationship summaries). Version strings only need
 * stability across runs, not cryptographic strength.
 */
function stableHexDigest(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const b of bytes) {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (b + 1), 0x811c9dc5) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** Convenience factory. */
export function createGitHubIndexer(
  configInput: GitHubIndexerConfigInput,
  deps: IndexerDeps,
): GitHubIndexer {
  return new GitHubIndexer(configInput, deps);
}

export type {
  ApprovedRepo,
  GitHubIndexerConfig,
  GitHubIndexerConfigInput,
  IndexedChunk,
  ResolvedApprovedRepo,
  SourceArtifact,
  StoredArtifact,
};
export { repoIdentity };
export {
  commandEntityId,
  permissionEntityId,
  pluginEntityId,
  repoEntityId,
  fileEntityId,
};
