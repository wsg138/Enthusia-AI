/**
 * @enthusia/integration-sftp — indexer configuration (W09).
 *
 * Validated with Zod per spec §9.1. SECURITY NOTE (§5.5, "Tools hold
 * credentials; models do not"): this schema deliberately has NO field for
 * passwords, private keys, passphrases, or any other credential material.
 * Credentials are resolved at connect time by a `SftpCredentialsProvider`
 * supplied by the tool layer (see sftp-client.ts); the config file only
 * names *where* to resolve them from (an env var name or a secret-manager
 * reference) via `authRef`. A config file can therefore be committed,
 * logged, and indexed without ever carrying a secret.
 *
 * Fail-closed parsing: every schema is strict — unknown keys are REJECTED,
 * not silently stripped, so a config that smuggles `password` or
 * `privateKey` fails loudly instead of being misread as credential-free.
 *
 * Spec: MASTER-SPECIFICATION.md §24.1 (allowlist model), §5.5, §9.1;
 * WORKER-EXECUTION-PLAN.md §12.
 */

import { z } from 'zod';
import { Visibility } from '@enthusia/contracts';
import { compileExtraDenyPatterns, type DenyRule } from './deny.js';

const serverIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'server id must be lowercase alphanumeric with dashes');

const absolutePosixPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^\/[^\\]*$/, 'path must be an absolute POSIX path')
  .refine((p) => !p.includes('\0'), 'path must not contain NUL');

/** One allowlisted root on a server: nothing outside these roots is ever listed or read. */
export const sftpRootSchema = z.strictObject({
  /** Absolute remote root, e.g. `/home/minecraft/smp/plugins`. */
  path: absolutePosixPathSchema,
  /**
   * Visibility assigned to artifacts indexed from this root.
   * Conservative default: STAFF (server configs/logs are internal
   * operational information, §17.3). Public-safe roots (e.g. published
   * rule docs mirrored on the server) may opt into PUBLIC explicitly.
   */
  visibility: z.nativeEnum(Visibility).default(Visibility.STAFF),
  /** Optional allowlist of file extensions (with dot), e.g. ['.yml', '.yaml', '.txt']. */
  includeExtensions: z.array(z.string().regex(/^\.[a-z0-9]+$/i)).optional(),
  /** Optional additional substring/regex deny rules applied on top of the hard deny set. */
  extraDenyPatterns: z.array(z.string().min(1)).optional(),
});

export type SftpRootConfig = z.infer<typeof sftpRootSchema>;

/** Where the tool layer should resolve credentials from. Never the credential itself. */
export const authSourceSchema = z.enum(['env', 'secret-manager']);

export const sftpServerSchema = z.strictObject({
  /** Stable server identity used in source locators (`sftp:<id>:<path>`). */
  id: serverIdSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(255),
  readyTimeoutMs: z.number().int().positive().max(300_000).default(20_000),
  /** Credential resolution: which store + which reference — never the secret. */
  authSource: authSourceSchema.default('env'),
  /** Env var name or secret-manager reference holding the auth material. */
  authRef: z.string().min(1).max(255),
  /** Allowlisted roots: the ONLY remote paths this indexer may touch. */
  roots: z.array(sftpRootSchema).min(1),
});

export type SftpServerConfig = z.infer<typeof sftpServerSchema>;

export const sftpIndexerConfigSchema = z.strictObject({
  servers: z.array(sftpServerSchema).min(1).refine(
    (servers) => new Set(servers.map((s) => s.id)).size === servers.length,
    'server ids must be unique',
  ),
  /** Hard cap on any single file read (bytes). Files larger than this are skipped, never truncated-and-indexed. */
  maxFileBytes: z.number().int().positive().max(256 * 1024 * 1024).default(4 * 1024 * 1024),
  /** Max directory depth below a root. 0 = the root directory itself. */
  maxDepth: z.number().int().min(0).max(32).default(12),
  /** Periodic reconciliation interval (ms); 0 disables the scheduler. */
  reconcileIntervalMs: z.number().int().min(0).max(24 * 3_600_000).default(15 * 60_000),
  /** Random jitter applied to each reconciliation tick (ms). */
  reconcileJitterMs: z.number().int().min(0).max(3_600_000).default(60_000),
});

export type SftpIndexerConfig = z.infer<typeof sftpIndexerConfigSchema>;

/** Validated config with compiled deny rules ready for the indexer. */
export interface CompiledSftpIndexerConfig {
  config: SftpIndexerConfig;
  /**
   * Extra deny rules per root, keyed by `${serverId}:${rootPath}`.
   * The unconditional HARD_DENY_RULES are always applied first.
   */
  extraDenyByRoot: ReadonlyMap<string, readonly DenyRule[]>;
}

export function compileConfig(input: unknown): CompiledSftpIndexerConfig {
  const config = sftpIndexerConfigSchema.parse(input);
  const extraDenyByRoot = new Map<string, readonly DenyRule[]>();
  for (const server of config.servers) {
    for (const root of server.roots) {
      if (root.extraDenyPatterns !== undefined && root.extraDenyPatterns.length > 0) {
        extraDenyByRoot.set(
          `${server.id}:${root.path}`,
          compileExtraDenyPatterns(root.extraDenyPatterns),
        );
      }
    }
  }
  return { config, extraDenyByRoot };
}
