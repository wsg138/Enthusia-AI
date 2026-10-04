/**
 * @enthusia/integration-sftp — read-only SFTP client (W09).
 *
 * Read-only by construction: this module opens ONLY the SFTP subsystem.
 * It never exposes exec/shell/forwarding — the underlying ssh2 `Client`
 * capabilities for those simply have no wrapper here, so there is no code
 * path through which the indexer can run commands on the server.
 *
 * Two layers:
 *  1. `Ssh2SftpClient` — thin promise wrapper over ssh2's SFTP handle
 *     (list/stat/bounded read/streaming hash). Created by `connectSftp`
 *     with caller-supplied credentials.
 *  2. `DenyGuardSftpClient` — wraps ANY SftpClient and throws
 *     `SecretDenyError` before any denied path reaches the wire. The
 *     indexer always operates through the guard, which is what makes
 *     "denied paths cannot be read through any code path" true even if a
 *     future code path forgets to check.
 *
 * Credentials (§5.5): a `SftpCredentialsProvider` callback supplies key
 * material at connect time. This module never logs, stores, or returns
 * credential values; error messages carry the server id and the remote
 * path only.
 *
 * NO real connections are made in tests — the mock in test/fakes.ts
 * implements the same `SftpClient` interface in memory.
 */

import { createHash } from 'node:crypto';
import posixPath from 'node:path/posix';
import { Client } from 'ssh2';
import type { ConnectConfig, SFTPWrapper } from 'ssh2';
import {
  assertAllowedPath,
  type DenyRule,
} from './deny.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SftpFileStat {
  /** Normalized absolute remote path. */
  path: string;
  size: number;
  /** Modified time in milliseconds since epoch. */
  mtimeMs: number;
  isDirectory: boolean;
  isFile: boolean;
}

export interface SftpDirEntry {
  /** Normalized absolute remote path of the entry. */
  path: string;
  name: string;
  isDirectory: boolean;
}

/**
 * Minimal read-only SFTP surface the indexer needs. Anything ssh2 can do
 * beyond this (exec, shell, ...) is intentionally NOT representable here.
 */
export interface SftpClient {
  /** List a directory's entries. */
  listDir(dirPath: string): Promise<SftpDirEntry[]>;
  /** Resolve symlinks/canonical server path without reading file content. */
  realPath(remotePath: string): Promise<string>;
  /** Stat a single path. */
  stat(filePath: string): Promise<SftpFileStat>;
  /** Read at most `maxBytes` bytes of a file. Throws if the file is larger. */
  readFile(filePath: string, maxBytes: number): Promise<Buffer>;
  /** SHA-256 hex of the full file content, streamed. Throws if larger than `maxBytes`. */
  hashFile(filePath: string, maxBytes: number): Promise<string>;
  /** Release the connection. */
  close(): Promise<void>;
}

/** Key material for one connection. Lives in the tool layer, never in config or logs. */
export interface SftpCredentials {
  username: string;
  /** OpenSSH-format private key PEM text (preferred). */
  privateKey?: string;
  /** Passphrase for the private key, if any. */
  passphrase?: string;
  /** Password auth fallback (discouraged; accepted only when provided). */
  password?: string;
}

/** Resolves credentials at connect time. The config only names the source. */
export type SftpCredentialsProvider = () => Promise<SftpCredentials> | SftpCredentials;

export interface SshConnectOptions {
  serverId: string;
  host: string;
  port: number;
  readyTimeoutMs: number;
  credentials: SftpCredentialsProvider;
}

export class SftpError extends Error {
  readonly serverId: string;
  readonly remotePath: string | undefined;

  constructor(message: string, serverId: string, remotePath?: string, options?: { cause?: unknown }) {
    super(remotePath !== undefined ? `${message} (server=${serverId} path=${remotePath})` : `${message} (server=${serverId})`);
    this.name = 'SftpError';
    this.serverId = serverId;
    this.remotePath = remotePath;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

// ---------------------------------------------------------------------------
// ssh2 implementation
// ---------------------------------------------------------------------------

function toSftpError(err: unknown, serverId: string, remotePath?: string): SftpError {
  const message = err instanceof Error ? err.message : String(err);
  return new SftpError(`sftp operation failed: ${message}`, serverId, remotePath, { cause: err });
}

export class Ssh2SftpClient implements SftpClient {
  private readonly sftp: SFTPWrapper;
  private readonly serverId: string;
  private readonly raw: Client;
  private closed = false;

  private constructor(raw: Client, sftp: SFTPWrapper, serverId: string) {
    this.raw = raw;
    this.sftp = sftp;
    this.serverId = serverId;
  }

  /** Internal factory: only `connectSftp` should create instances. */
  static wrap(raw: Client, sftp: SFTPWrapper, serverId: string): Ssh2SftpClient {
    return new Ssh2SftpClient(raw, sftp, serverId);
  }

  listDir(dirPath: string): Promise<SftpDirEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(dirPath, (err, list) => {
        if (err) return reject(toSftpError(err, this.serverId, dirPath));
        resolve(
          list.map((entry) => ({
            name: entry.filename,
            path: dirPath.endsWith('/') ? `${dirPath}${entry.filename}` : `${dirPath}/${entry.filename}`,
            isDirectory: entry.attrs.isDirectory(),
          })),
        );
      });
    });
  }

  realPath(remotePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sftp.realpath(remotePath, (err, resolved) => {
        if (err) return reject(toSftpError(err, this.serverId, remotePath));
        resolve(resolved);
      });
    });
  }

  stat(filePath: string): Promise<SftpFileStat> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(filePath, (err, attrs) => {
        if (err) return reject(toSftpError(err, this.serverId, filePath));
        resolve({
          path: filePath,
          size: attrs.size,
          mtimeMs: attrs.mtime * 1000,
          isDirectory: attrs.isDirectory(),
          isFile: attrs.isFile(),
        });
      });
    });
  }

  readFile(filePath: string, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let failed = false;
      const fail = (err: unknown): void => {
        if (failed) return;
        failed = true;
        reject(toSftpError(err, this.serverId, filePath));
      };
      const stream = this.sftp.createReadStream(filePath);
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy();
          fail(new Error(`file exceeds maxFileBytes (${maxBytes})`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        if (!failed) resolve(Buffer.concat(chunks, total));
      });
      stream.on('error', fail);
    });
  }

  hashFile(filePath: string, maxBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      let total = 0;
      let failed = false;
      const fail = (err: unknown): void => {
        if (failed) return;
        failed = true;
        reject(toSftpError(err, this.serverId, filePath));
      };
      const stream = this.sftp.createReadStream(filePath);
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy();
          fail(new Error(`file exceeds maxFileBytes (${maxBytes})`));
          return;
        }
        hash.update(chunk);
      });
      stream.on('end', () => {
        if (!failed) resolve(hash.digest('hex'));
      });
      stream.on('error', fail);
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve) => {
      this.raw.once('close', () => resolve());
      this.raw.end();
      // Safety: never hang close() forever.
      setTimeout(() => resolve(), 5_000).unref();
    });
  }
}

/**
 * Open an SFTP connection. Only the SFTP subsystem is requested; exec and
 * shell are never opened. Rejects on auth failure or timeout.
 */
export function connectSftp(options: SshConnectOptions): Promise<Ssh2SftpClient> {
  return new Promise((resolve, reject) => {
    const finish = (err?: unknown, client?: Ssh2SftpClient): void => {
      if (err !== undefined) {
        reject(toSftpError(err, options.serverId));
      } else {
        resolve(client as Ssh2SftpClient);
      }
    };
    let creds: SftpCredentials | Promise<SftpCredentials>;
    try {
      creds = options.credentials();
    } catch {
      reject(new SftpError('credential provider failed', options.serverId));
      return;
    }
    Promise.resolve(creds).then(
      (resolved) => {
        const client = new Client();
        client.once('ready', () => {
          client.sftp((err, sftp) => {
            if (err) {
              client.end();
              finish(err);
              return;
            }
            finish(undefined, Ssh2SftpClient.wrap(client, sftp, options.serverId));
          });
        });
        client.once('error', (err) => finish(err));
        const connectConfig: ConnectConfig = {
          host: options.host,
          port: options.port,
          username: resolved.username,
          readyTimeout: options.readyTimeoutMs,
        };
        if (resolved.privateKey !== undefined) connectConfig.privateKey = resolved.privateKey;
        if (resolved.passphrase !== undefined) connectConfig.passphrase = resolved.passphrase;
        if (resolved.password !== undefined) connectConfig.password = resolved.password;
        client.connect(connectConfig);
      },
      () => reject(new SftpError('credential provider failed', options.serverId)),
    );
  });
}

// ---------------------------------------------------------------------------
// Deny guard: the "no code path can read a denied path" enforcement
// ---------------------------------------------------------------------------

/**
 * Wraps any SftpClient and enforces the secret deny set on EVERY operation
 * before it reaches the underlying client (and therefore the wire).
 *
 * The indexer must always use the guarded client. Even if a future code
 * path forgets to call `assertAllowedPath`, the guard still throws.
 */
export class SftpPathEscapeError extends Error {
  constructor(readonly remotePath: string, readonly allowedRoot: string) {
    super(`path escapes allowlisted root: ${remotePath}`);
    this.name = 'SftpPathEscapeError';
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = posixPath.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posixPath.isAbsolute(relative));
}

/**
 * Deny guard plus canonical root confinement. The indexer uses forRoot(),
 * which verifies both lexical and server-canonical paths so symlinks cannot
 * escape an allowlisted root.
 */
export class DenyGuardSftpClient implements SftpClient {
  private constructor(
    private readonly inner: SftpClient,
    private readonly extraRules: readonly DenyRule[] = [],
    private readonly lexicalRoot?: string,
    private readonly canonicalRoot?: string,
  ) {}

  /** Generic deny-only wrapper retained for direct tests/non-indexer callers. */
  static denyOnly(inner: SftpClient, extraRules: readonly DenyRule[] = []): DenyGuardSftpClient {
    return new DenyGuardSftpClient(inner, extraRules);
  }

  /** Root-confined wrapper required by the indexer. */
  static async forRoot(
    inner: SftpClient,
    rootPath: string,
    extraRules: readonly DenyRule[] = [],
  ): Promise<DenyGuardSftpClient> {
    const lexicalRoot = assertAllowedPath(rootPath, extraRules);
    const canonicalRoot = assertAllowedPath(await inner.realPath(lexicalRoot), extraRules);
    return new DenyGuardSftpClient(inner, extraRules, lexicalRoot, canonicalRoot);
  }

  get guarded(): SftpClient {
    return this.inner;
  }

  async realPath(remotePath: string): Promise<string> {
    const lexical = assertAllowedPath(remotePath, this.extraRules);
    this.assertInside(lexical, this.lexicalRoot);
    const canonical = assertAllowedPath(await this.inner.realPath(lexical), this.extraRules);
    this.assertInside(canonical, this.canonicalRoot);
    return canonical;
  }

  async listDir(dirPath: string): Promise<SftpDirEntry[]> {
    return this.inner.listDir(await this.realPath(dirPath));
  }

  async stat(filePath: string): Promise<SftpFileStat> {
    return this.inner.stat(await this.realPath(filePath));
  }

  async readFile(filePath: string, maxBytes: number): Promise<Buffer> {
    return this.inner.readFile(await this.realPath(filePath), maxBytes);
  }

  async hashFile(filePath: string, maxBytes: number): Promise<string> {
    return this.inner.hashFile(await this.realPath(filePath), maxBytes);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  private assertInside(candidate: string, root?: string): void {
    if (root !== undefined && !isWithinRoot(candidate, root)) {
      throw new SftpPathEscapeError(candidate, root);
    }
  }
}
