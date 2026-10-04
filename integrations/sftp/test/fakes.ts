/**
 * @enthusia/integration-sftp — test fakes (W09).
 *
 * In-test doubles with NO real network I/O:
 *
 * - `MockSftpServer`: an in-memory SFTP fixture implementing `SftpClient`.
 *   Tests mutate its file tree (write/delete/rename) to simulate config
 *   changes between scans. It also records every operation so tests can
 *   assert that unchanged files are never re-read and denied paths are
 *   never touched.
 * - `FakeRegistry`: register() with CREATED / UNCHANGED / SUPERSEDED
 *   outcomes, deterministic artifact ids, getCurrent, listCurrent,
 *   markInvalid — the same lifecycle contract as W04's SourceRegistry.
 * - `FakeRetrieval`: indexArtifactText() cuts text into chunks and stamps
 *   provenance; updateArtifactStatus() flips every chunk of an artifact;
 *   removeArtifact() drops them — the same contract as W07's engine
 *   methods used by the indexer.
 */

import { createHash } from 'node:crypto';
import posixPath from 'node:path/posix';
import {
  SourceStatus,
  SourceType,
  Visibility,
  type SourceArtifact,
} from '@enthusia/contracts';
import type { SftpClient, SftpDirEntry, SftpFileStat } from '../src/sftp-client.js';
import type {
  ArtifactRegistryPort,
  IndexedChunk,
  RegisterArtifactInput,
  RegisterOutcome,
  RegisterResult,
  RetrievalEnginePort,
  StoredArtifact,
} from '../src/ports.js';

// ---------------------------------------------------------------------------
// MockSftpServer — in-memory SFTP fixture
// ---------------------------------------------------------------------------

interface MockFile {
  kind: 'file';
  content: Buffer;
  mtimeMs: number;
}

interface MockDir {
  kind: 'dir';
}
interface MockSymlink {
  kind: 'symlink';
  target: string;
}

type MockNode = MockFile | MockDir | MockSymlink;

function norm(p: string): string {
  const n = posixPath.normalize(p.replace(/\\/g, '/'));
  return n.startsWith('/') ? n : `/${n}`;
}

export class MockSftpServer implements SftpClient {
  private readonly nodes = new Map<string, MockNode>();
  /** Operation log for assertions: e.g. 'listDir:/a', 'readFile:/a/b.yml'. */
  readonly operations: string[] = [];

  constructor() {
    this.nodes.set('/', { kind: 'dir' });
  }

  // -- fixture mutation ------------------------------------------------------

  mkdirp(dirPath: string): void {
    const n = norm(dirPath);
    const parts = n.split('/').filter((s) => s.length > 0);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      if (!this.nodes.has(cur)) this.nodes.set(cur, { kind: 'dir' });
    }
  }

  writeFile(filePath: string, content: string | Buffer, mtimeMs = Date.now()): void {
    const n = norm(filePath);
    this.mkdirp(posixPath.dirname(n));
    this.nodes.set(n, {
      kind: 'file',
      content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
      mtimeMs,
    });
  }

  symlink(linkPath: string, target: string): void {
    const n = norm(linkPath);
    this.mkdirp(posixPath.dirname(n));
    this.nodes.set(n, { kind: 'symlink', target: norm(target) });
  }

  deletePath(path: string): void {
    const n = norm(path);
    for (const key of [...this.nodes.keys()]) {
      if (key === n || key.startsWith(`${n}/`)) this.nodes.delete(key);
    }
  }

  /** Simulate an in-place config edit (same mtime) vs a real edit (new mtime). */
  touchMtime(filePath: string, mtimeMs: number): void {
    const node = this.nodes.get(norm(filePath));
    if (node?.kind === 'file') node.mtimeMs = mtimeMs;
  }

  readFixture(filePath: string): Buffer | undefined {
    const node = this.nodes.get(norm(filePath));
    return node?.kind === 'file' ? node.content : undefined;
  }

  // -- SftpClient ------------------------------------------------------------

  async realPath(remotePath: string): Promise<string> {
    const n = norm(remotePath);
    this.operations.push(`realPath:${n}`);
    const node = this.nodes.get(n);
    if (node?.kind === 'symlink') return node.target;
    return n;
  }

  async listDir(dirPath: string): Promise<SftpDirEntry[]> {
    const n = norm(dirPath);
    this.operations.push(`listDir:${n}`);
    const node = this.nodes.get(n);
    if (node === undefined || node.kind !== 'dir') {
      throw new Error(`ENOENT: no such directory ${n}`);
    }
    const entries: SftpDirEntry[] = [];
    for (const key of this.nodes.keys()) {
      if (key === n) continue;
      if (posixPath.dirname(key) === n) {
        const child = this.nodes.get(key);
        entries.push({
          path: key,
          name: posixPath.basename(key),
          isDirectory: child?.kind === 'dir',
        });
      }
    }
    return entries;
  }

  async stat(filePath: string): Promise<SftpFileStat> {
    const n = norm(filePath);
    this.operations.push(`stat:${n}`);
    const node = this.nodes.get(n);
    if (node === undefined) throw new Error(`ENOENT: no such file ${n}`);
    return {
      path: n,
      size: node.kind === 'file' ? node.content.length : 0,
      mtimeMs: node.kind === 'file' ? node.mtimeMs : 0,
      isDirectory: node.kind === 'dir',
      isFile: node.kind === 'file',
    };
  }

  async readFile(filePath: string, maxBytes: number): Promise<Buffer> {
    const n = norm(filePath);
    this.operations.push(`readFile:${n}`);
    const node = this.nodes.get(n);
    if (node === undefined || node.kind !== 'file') throw new Error(`ENOENT: no such file ${n}`);
    if (node.content.length > maxBytes) {
      throw new Error(`file exceeds maxFileBytes (${maxBytes})`);
    }
    return Buffer.from(node.content);
  }

  async hashFile(filePath: string, maxBytes: number): Promise<string> {
    const n = norm(filePath);
    this.operations.push(`hashFile:${n}`);
    const node = this.nodes.get(n);
    if (node === undefined || node.kind !== 'file') throw new Error(`ENOENT: no such file ${n}`);
    if (node.content.length > maxBytes) {
      throw new Error(`file exceeds maxFileBytes (${maxBytes})`);
    }
    return createHash('sha256').update(node.content).digest('hex');
  }

  async close(): Promise<void> {
    this.operations.push('close');
  }

  count(opPrefix: string): number {
    return this.operations.filter((op) => op.startsWith(opPrefix)).length;
  }

  touched(pathFragment: string): boolean {
    return this.operations.some((op) => op.includes(pathFragment));
  }
}

// ---------------------------------------------------------------------------
// FakeRegistry — W04 SourceRegistry lifecycle semantics
// ---------------------------------------------------------------------------

function deriveArtifactId(sourceLocator: string, version: string): string {
  const digest = createHash('sha256')
    .update(`${sourceLocator}\n${version}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `art_${digest}`;
}

export class FakeRegistry implements ArtifactRegistryPort {
  private readonly byId = new Map<string, StoredArtifact>();
  private readonly currentByLocator = new Map<string, string>();

  register(input: RegisterArtifactInput): RegisterResult {
    const artifactId = deriveArtifactId(input.sourceLocator, input.version);
    const now = new Date().toISOString();
    const identical = this.byId.get(artifactId);
    if (identical !== undefined && identical.sourceLocator === input.sourceLocator) {
      return { artifact: identical, outcome: 'UNCHANGED' };
    }
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
    const artifact: StoredArtifact = { ...base, status: SourceStatus.CURRENT };

    const previousId = this.currentByLocator.get(input.sourceLocator);
    let supersededArtifactId: string | undefined;
    let outcome: RegisterOutcome = 'CREATED';
    if (previousId !== undefined && previousId !== artifactId) {
      const previous = this.byId.get(previousId);
      if (previous !== undefined) {
        previous.status = SourceStatus.SUPERSEDED;
        previous.current = false;
        supersededArtifactId = previousId;
        outcome = 'SUPERSEDED';
      }
    }
    this.byId.set(artifactId, artifact);
    this.currentByLocator.set(input.sourceLocator, artifactId);
    if (supersededArtifactId !== undefined) {
      return { artifact, outcome, supersededArtifactId };
    }
    return { artifact, outcome };
  }

  getCurrent(sourceLocator: string): StoredArtifact | undefined {
    const id = this.currentByLocator.get(sourceLocator);
    const artifact = id !== undefined ? this.byId.get(id) : undefined;
    return artifact !== undefined && artifact.current ? artifact : undefined;
  }

  listCurrent(filter: { sourceType?: SourceType; component?: string } = {}): StoredArtifact[] {
    return [...this.byId.values()].filter(
      (a) =>
        a.status === SourceStatus.CURRENT &&
        (filter.sourceType === undefined || a.sourceType === filter.sourceType) &&
        (filter.component === undefined || a.component === filter.component),
    );
  }

  markStale(artifactId: string): StoredArtifact {
    const artifact = this.byId.get(artifactId);
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    artifact.status = SourceStatus.STALE;
    artifact.current = true;
    return artifact;
  }

  revalidate(artifactId: string, observedTime = new Date().toISOString()): StoredArtifact {
    const artifact = this.byId.get(artifactId);
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    artifact.status = SourceStatus.CURRENT;
    artifact.current = true;
    artifact.observedTime = observedTime;
    this.currentByLocator.set(artifact.sourceLocator, artifactId);
    return artifact;
  }

  markInvalid(artifactId: string): StoredArtifact {
    const artifact = this.byId.get(artifactId);
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    artifact.status = SourceStatus.INVALID;
    artifact.current = false;
    if (this.currentByLocator.get(artifact.sourceLocator) === artifactId) {
      this.currentByLocator.delete(artifact.sourceLocator);
    }
    return artifact;
  }

  /** Test helper: every artifact ever registered (history included). */
  all(): StoredArtifact[] {
    return [...this.byId.values()];
  }
}

// ---------------------------------------------------------------------------
// FakeRetrieval — W07 engine semantics used by the indexer
// ---------------------------------------------------------------------------

export class FakeRetrieval implements RetrievalEnginePort {
  readonly chunks = new Map<string, IndexedChunk>();

  async indexArtifactText(
    artifact: SourceArtifact,
    status: SourceStatus,
    text: string,
  ): Promise<IndexedChunk[]> {
    if (artifact.visibility === Visibility.SECRET_DENY) {
      throw new Error('refusing to index SECRET_DENY artifact');
    }
    // Simple paragraph chunker: mirrors "chunk then stamp provenance".
    const cuts = text.split(/\n\n+/).map((t) => t.trim()).filter((t) => t.length > 0);
    const indexed: IndexedChunk[] = cuts.map((cut, i) => {
      const chunk: IndexedChunk = {
        chunkId: `${artifact.artifactId}#${i}`,
        artifactId: artifact.artifactId,
        status,
        visibility: artifact.visibility,
        sourceType: artifact.sourceType,
        text: cut,
      };
      this.chunks.set(chunk.chunkId, chunk);
      return chunk;
    });
    return indexed;
  }

  async updateArtifactStatus(artifactId: string, status: SourceStatus): Promise<number> {
    let updated = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.artifactId === artifactId) {
        chunk.status = status;
        updated += 1;
      }
    }
    return updated;
  }

  async removeArtifact(artifactId: string): Promise<void> {
    for (const [id, chunk] of [...this.chunks]) {
      if (chunk.artifactId === artifactId) this.chunks.delete(id);
    }
  }

  chunksFor(artifactId: string): IndexedChunk[] {
    return [...this.chunks.values()].filter((c) => c.artifactId === artifactId);
  }
}
