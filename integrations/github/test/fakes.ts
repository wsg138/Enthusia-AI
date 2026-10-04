/**
 * @enthusia/integration-github — test fakes (W08).
 *
 * In-test doubles that replicate the W04 `SourceRegistry` and W07
 * `KnowledgeRetrievalEngine` semantics WITHOUT importing their code:
 *
 * - `FakeRegistry`: register() with CREATED / UNCHANGED / SUPERSEDED
 *   outcomes, deterministic artifact ids, getCurrent, listCurrent,
 *   markInvalid — the same lifecycle contract as W04's SourceRegistry.
 * - `FakeRetrieval`: indexArtifactText() chunks via the provided chunker
 *   and stamps provenance; updateArtifactStatus() flips every chunk of an
 *   artifact — the same contract as W07's engine methods.
 * - `MockGitHubApi`: an in-memory GitHub fixture — mutable trees and
 *   blobs so tests can "push a commit" and verify incremental behavior.
 *
 * NO real network I/O anywhere in this file.
 */

import { createHash } from 'node:crypto';
import {
  SourceStatus,
  SourceType,
  Visibility,
  type SourceArtifact,
} from '@enthusia/contracts';
import type {
  GitBlob,
  GitHubApi,
  GitHubDiscussion,
  GitHubRepoMeta,
  GitTreeEntry,
} from '../src/github-client.js';
import type {
  ArtifactRegistryPort,
  IndexedChunk,
  RegisterArtifactInput,
  RegisterResult,
  RetrievalEnginePort,
  StoredArtifact,
  TextChunker,
} from '../src/ports.js';

// ---------------------------------------------------------------------------
// FakeRegistry — W04 SourceRegistry lifecycle semantics
// ---------------------------------------------------------------------------

function deriveArtifactId(sourceLocator: string, version: string, predecessor?: string): string {
  const lineage = predecessor === undefined ? '' : `\n${predecessor}`;
  const digest = createHash('sha256')
    .update(`${sourceLocator}\n${version}${lineage}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `art_${digest}`;
}

export class FakeRegistry implements ArtifactRegistryPort {
  private readonly byId = new Map<string, StoredArtifact>();
  private readonly currentByLocator = new Map<string, string>();

  register(input: RegisterArtifactInput): RegisterResult {
    const now = new Date().toISOString();
    const previousId = this.currentByLocator.get(input.sourceLocator);
    const previous = previousId !== undefined ? this.byId.get(previousId) : undefined;
    if (previous !== undefined && previous.version === input.version) {
      if (previous.status === SourceStatus.STALE) {
        const refreshed = { ...previous, status: SourceStatus.CURRENT, current: true, observedTime: input.observedTime ?? now };
        this.byId.set(previous.artifactId, refreshed);
        return { artifact: refreshed, outcome: 'UNCHANGED' };
      }
      return { artifact: previous, outcome: 'UNCHANGED' };
    }
    const artifactId = deriveArtifactId(input.sourceLocator, input.version, previous?.artifactId);
    const base: SourceArtifact = {
      artifactId,
      sourceType: input.sourceType,
      sourceLocator: input.sourceLocator,
      component: input.component,
      visibility: input.visibility ?? Visibility.STAFF,
      authority: input.authority,
      version: input.version,
      observedTime: input.observedTime ?? now,
      indexedTime: now,
      current: true,
    };
    if (input.contentMetadata !== undefined) base.contentMetadata = input.contentMetadata;
    if (input.parserVersion !== undefined) base.parserVersion = input.parserVersion;
    if (input.embeddingVersion !== undefined) base.embeddingVersion = input.embeddingVersion;
    const stored: StoredArtifact = { ...base, status: SourceStatus.CURRENT };
    if (previous !== undefined) {
      const superseded: StoredArtifact = { ...previous, status: SourceStatus.SUPERSEDED, current: false };
      this.byId.set(previous.artifactId, superseded);
    }
    this.byId.set(artifactId, stored);
    this.currentByLocator.set(input.sourceLocator, artifactId);
    return previous === undefined
      ? { artifact: stored, outcome: 'CREATED' }
      : { artifact: stored, outcome: 'SUPERSEDED', supersededArtifactId: previous.artifactId };
  }

  getCurrent(sourceLocator: string): StoredArtifact | undefined {
    const id = this.currentByLocator.get(sourceLocator);
    if (id === undefined) return undefined;
    const artifact = this.byId.get(id);
    return artifact !== undefined && artifact.current ? artifact : undefined;
  }

  listCurrent(filter?: { sourceType?: SourceType; component?: string }): StoredArtifact[] {
    const out: StoredArtifact[] = [];
    for (const artifact of this.byId.values()) {
      if (artifact.status !== SourceStatus.CURRENT) continue;
      if (filter?.sourceType !== undefined && artifact.sourceType !== filter.sourceType) continue;
      if (filter?.component !== undefined && artifact.component !== filter.component) continue;
      out.push(artifact);
    }
    return out;
  }

  markStale(artifactId: string): StoredArtifact {
    const artifact = this.byId.get(artifactId);
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    const stale: StoredArtifact = { ...artifact, status: SourceStatus.STALE, current: true };
    this.byId.set(artifactId, stale);
    return stale;
  }

  revalidate(artifactId: string, observedTime = new Date().toISOString()): StoredArtifact {
    const artifact = this.byId.get(artifactId);
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    const current: StoredArtifact = {
      ...artifact,
      status: SourceStatus.CURRENT,
      current: true,
      observedTime,
    };
    this.byId.set(artifactId, current);
    this.currentByLocator.set(current.sourceLocator, artifactId);
    return current;
  }

  markInvalid(artifactId: string): StoredArtifact {
    const artifact = this.byId.get(artifactId);
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    const invalid: StoredArtifact = { ...artifact, status: SourceStatus.INVALID, current: false };
    this.byId.set(artifactId, invalid);
    if (this.currentByLocator.get(artifact.sourceLocator) === artifactId) {
      this.currentByLocator.delete(artifact.sourceLocator);
    }
    return invalid;
  }

  /** Every stored artifact (including SUPERSEDED/INVALID/STALE history). */
  all(): StoredArtifact[] {
    return [...this.byId.values()];
  }
}

// ---------------------------------------------------------------------------
// FakeRetrieval — W07 engine indexing/status semantics
// ---------------------------------------------------------------------------

export class FakeRetrieval implements RetrievalEnginePort {
  readonly chunks: IndexedChunk[] = [];
  readonly statusUpdates: Array<{ artifactId: string; status: SourceStatus }> = [];

  async indexArtifactText(
    artifact: SourceArtifact,
    status: SourceStatus,
    text: string,
    chunker?: TextChunker,
  ): Promise<IndexedChunk[]> {
    if (chunker === undefined) throw new Error('no chunker available');
    const cuts = chunker.chunk(text);
    const chunks: IndexedChunk[] = cuts.map((cut, i) => {
      const chunk: IndexedChunk = {
        chunkId: `${artifact.artifactId}#${i}`,
        artifactId: artifact.artifactId,
        version: artifact.version,
        status,
        visibility: artifact.visibility,
        sourceType: artifact.sourceType,
        component: artifact.component,
        authority: artifact.authority,
        sourceLocator: artifact.sourceLocator,
        text: cut.text,
        chunkIndex: i,
        tokenCount: Math.ceil(cut.text.length / 4),
      };
      if (cut.heading !== undefined) chunk.metadata = { heading: cut.heading };
      return chunk;
    });
    // Replace semantics: same chunkId replaces the previous chunk.
    for (const chunk of chunks) {
      const existing = this.chunks.findIndex((c) => c.chunkId === chunk.chunkId);
      if (existing >= 0) this.chunks[existing] = chunk;
      else this.chunks.push(chunk);
    }
    return chunks;
  }

  async updateArtifactStatus(artifactId: string, status: SourceStatus): Promise<number> {
    this.statusUpdates.push({ artifactId, status });
    let updated = 0;
    for (const chunk of this.chunks) {
      if (chunk.artifactId === artifactId) {
        chunk.status = status;
        updated += 1;
      }
    }
    return updated;
  }

  chunksForArtifact(artifactId: string): IndexedChunk[] {
    return this.chunks.filter((c) => c.artifactId === artifactId);
  }
}

// ---------------------------------------------------------------------------
// MockGitHubApi — mutable in-memory repository fixture
// ---------------------------------------------------------------------------

export interface FixtureFile {
  path: string;
  /** Blob SHA; tests mutate this to simulate a commit. */
  sha: string;
  content: string;
  size?: number;
}

export class MockGitHubApi implements GitHubApi {
  /** commitSha -> files at that commit. */
  private readonly commits = new Map<string, FixtureFile[]>();
  private readonly blobs = new Map<string, string>();
  readonly defaultBranch = 'main';
  /** Counts blob fetches — proves unchanged files are never re-fetched. */
  blobFetchCount = 0;
  /** Every blob SHA ever fetched, in order. */
  fetchedShas: string[] = [];
  headSha: string;
  issues: GitHubDiscussion[] = [];
  pullRequests: GitHubDiscussion[] = [];
  failIssueList = false;
  failPullRequestList = false;
  readonly failBlobShas = new Set<string>();

  constructor(initialCommitSha: string, files: FixtureFile[]) {
    this.headSha = initialCommitSha;
    this.setCommit(initialCommitSha, files);
  }

  /** Simulate pushing a new commit: replaces the tree at the new SHA. */
  setCommit(commitSha: string, files: FixtureFile[]): void {
    this.commits.set(commitSha, files);
    for (const f of files) this.blobs.set(f.sha, f.content);
    this.headSha = commitSha;
  }

  /** Simulate editing one file in a new commit (content + new blob SHA). */
  editFile(newCommitSha: string, path: string, newContent: string, newSha: string): void {
    const current = this.commits.get(this.headSha) ?? [];
    const next = current.map((f) =>
      f.path === path ? { ...f, sha: newSha, content: newContent } : f,
    );
    this.setCommit(newCommitSha, next);
  }

  /** Simulate deleting a file in a new commit. */
  deleteFile(newCommitSha: string, path: string): void {
    const current = this.commits.get(this.headSha) ?? [];
    this.setCommit(newCommitSha, current.filter((f) => f.path !== path));
  }

  async getRepoMeta(owner: string, repo: string): Promise<GitHubRepoMeta> {
    return { owner, repo, defaultBranch: this.defaultBranch, isPublic: true };
  }

  async getBranchHeadSha(): Promise<string> {
    return this.headSha;
  }

  async getRecursiveTree(): Promise<GitTreeEntry[]> {
    const files = this.commits.get(this.headSha) ?? [];
    return files.map((f) => ({
      path: f.path,
      type: 'blob' as const,
      sha: f.sha,
      size: f.size ?? f.content.length,
    }));
  }

  async getBlob(_owner: string, _repo: string, blobSha: string): Promise<GitBlob> {
    this.blobFetchCount += 1;
    this.fetchedShas.push(blobSha);
    if (this.failBlobShas.delete(blobSha)) throw new Error(`transient blob failure ${blobSha}`);
    const content = this.blobs.get(blobSha);
    if (content === undefined) throw new Error(`unknown blob ${blobSha}`);
    return {
      sha: blobSha,
      contentBase64: Buffer.from(content, 'utf8').toString('base64'),
      size: content.length,
    };
  }

  async listIssues(): Promise<GitHubDiscussion[]> {
    if (this.failIssueList) throw new Error('transient issue-list failure');
    return this.issues;
  }

  async listPullRequests(): Promise<GitHubDiscussion[]> {
    if (this.failPullRequestList) throw new Error('transient pull-list failure');
    return this.pullRequests;
  }
}
