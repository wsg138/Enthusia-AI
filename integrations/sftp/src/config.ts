/**
 * @enthusia/integration-sftp — validated server-source configuration.
 *
 * Credential material is deliberately absent. authRef only tells the runtime
 * credential resolver where to obtain a secret. Model-visible APIs never
 * return host, username, authRef, or host-key configuration.
 */

import posixPath from 'node:path/posix';
import { z } from 'zod';
import { Visibility } from '@enthusia/contracts';
import {
  assertAllowedPath,
  compileExtraDenyPatterns,
  type DenyRule,
} from './deny.js';

const serverIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'server id must be lowercase alphanumeric with dashes');

const sourceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'source id must be lowercase alphanumeric with dots, dashes, or underscores');

const absolutePosixPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^\/[^\\]*$/, 'path must be an absolute POSIX path')
  .refine((path) => !path.includes('\0'), 'path must not contain NUL');

const modelVisibleVisibilitySchema = z
  .nativeEnum(Visibility)
  .refine((visibility) => visibility !== Visibility.SECRET_DENY, 'SECRET_DENY sources must not be configured as readable');

const hostKeySha256Schema = z
  .string()
  .regex(/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/, 'host key must be an OpenSSH SHA256 fingerprint');

export const sftpRootSchema = z.strictObject({
  path: absolutePosixPathSchema,
  visibility: modelVisibleVisibilitySchema.default(Visibility.STAFF),
  includeExtensions: z.array(z.string().regex(/^\.[a-z0-9]+$/i)).optional(),
  extraDenyPatterns: z.array(z.string().min(1)).optional(),
});

export type SftpRootConfig = z.infer<typeof sftpRootSchema>;

export const livePluginDirectorySchema = z.strictObject({
  id: sourceIdSchema,
  path: absolutePosixPathSchema,
  visibility: modelVisibleVisibilitySchema.default(Visibility.STAFF),
});

export const liveConfigDirectorySchema = z.strictObject({
  id: sourceIdSchema,
  path: absolutePosixPathSchema,
  visibility: modelVisibleVisibilitySchema.default(Visibility.STAFF),
  includeExtensions: z
    .array(z.string().regex(/^\.[a-z0-9]+$/i))
    .min(1)
    .default(['.yml', '.yaml', '.json', '.properties', '.toml', '.conf', '.cfg']),
  maxDepth: z.number().int().min(0).max(12).default(4),
});

export const liveApprovedFileSchema = z.strictObject({
  id: sourceIdSchema,
  path: absolutePosixPathSchema,
  kind: z.enum(['server-properties', 'config', 'deployment-identity']),
  format: z.enum(['properties', 'yaml', 'json', 'text']),
  visibility: modelVisibleVisibilitySchema.default(Visibility.STAFF),
});

export const liveSourceSchema = z.strictObject({
  displayName: z.string().min(1).max(128).optional(),
  environment: z.string().min(1).max(64).default('production'),
  operationTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
  maxJarBytes: z.number().int().positive().max(256 * 1024 * 1024).default(64 * 1024 * 1024),
  maxConfigBytes: z.number().int().positive().max(16 * 1024 * 1024).default(1024 * 1024),
  maxMetadataBytes: z.number().int().positive().max(4 * 1024 * 1024).default(512 * 1024),
  maxResults: z.number().int().positive().max(2_000).default(200),
  pluginDirectories: z.array(livePluginDirectorySchema).default([]),
  configDirectories: z.array(liveConfigDirectorySchema).default([]),
  approvedFiles: z.array(liveApprovedFileSchema).default([]),
});

export type LivePluginDirectoryConfig = z.infer<typeof livePluginDirectorySchema>;
export type LiveConfigDirectoryConfig = z.infer<typeof liveConfigDirectorySchema>;
export type LiveApprovedFileConfig = z.infer<typeof liveApprovedFileSchema>;
export type LiveSourceConfig = z.infer<typeof liveSourceSchema>;

export const authSourceSchema = z.enum(['env', 'secret-manager']);

export const sftpServerSchema = z.strictObject({
  id: serverIdSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(255),
  readyTimeoutMs: z.number().int().positive().max(300_000).default(20_000),
  authSource: authSourceSchema.default('env'),
  authRef: z.string().min(1).max(255),
  hostKeySha256: hostKeySha256Schema.optional(),
  roots: z.array(sftpRootSchema).min(1),
  liveSource: liveSourceSchema.optional(),
});

export type SftpServerConfig = z.infer<typeof sftpServerSchema>;

export const sftpIndexerConfigSchema = z.strictObject({
  servers: z.array(sftpServerSchema).min(1).refine(
    (servers) => new Set(servers.map((server) => server.id)).size === servers.length,
    'server ids must be unique',
  ),
  maxFileBytes: z.number().int().positive().max(256 * 1024 * 1024).default(4 * 1024 * 1024),
  maxDepth: z.number().int().min(0).max(32).default(12),
  reconcileIntervalMs: z.number().int().min(0).max(24 * 3_600_000).default(15 * 60_000),
  reconcileJitterMs: z.number().int().min(0).max(3_600_000).default(60_000),
});

export type SftpIndexerConfig = z.infer<typeof sftpIndexerConfigSchema>;

export interface CompiledSftpIndexerConfig {
  config: SftpIndexerConfig;
  extraDenyByRoot: ReadonlyMap<string, readonly DenyRule[]>;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = posixPath.relative(posixPath.normalize(root), posixPath.normalize(candidate));
  return relative === '' ||
    (relative !== '..' && !relative.startsWith('../') && !posixPath.isAbsolute(relative));
}

function findContainingRoot(
  server: SftpServerConfig,
  remotePath: string,
): SftpRootConfig | undefined {
  return server.roots
    .filter((root) => isWithinRoot(remotePath, root.path))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function validateLivePath(
  server: SftpServerConfig,
  remotePath: string,
  extraDenyByRoot: ReadonlyMap<string, readonly DenyRule[]>,
): void {
  const root = findContainingRoot(server, remotePath);
  if (root === undefined) {
    throw new Error('live source path is outside every allowlisted root: server=' + server.id);
  }
  const extra = extraDenyByRoot.get(server.id + ':' + root.path) ?? [];
  assertAllowedPath(remotePath, extra);
}

function validateLiveServer(
  server: SftpServerConfig,
  extraDenyByRoot: ReadonlyMap<string, readonly DenyRule[]>,
): void {
  const live = server.liveSource;
  if (live === undefined) return;
  if (server.hostKeySha256 === undefined) {
    throw new Error('live source requires pinned hostKeySha256: server=' + server.id);
  }

  const ids = [
    ...live.pluginDirectories.map((source) => source.id),
    ...live.configDirectories.map((source) => source.id),
    ...live.approvedFiles.map((source) => source.id),
  ];
  if (new Set(ids).size !== ids.length) {
    throw new Error('live source ids must be unique within server=' + server.id);
  }

  for (const source of live.pluginDirectories) {
    validateLivePath(server, source.path, extraDenyByRoot);
  }
  for (const source of live.configDirectories) {
    validateLivePath(server, source.path, extraDenyByRoot);
  }
  for (const source of live.approvedFiles) {
    validateLivePath(server, source.path, extraDenyByRoot);
  }
}

export function findConfiguredRoot(
  server: SftpServerConfig,
  remotePath: string,
): SftpRootConfig | undefined {
  return findContainingRoot(server, remotePath);
}

export function compileConfig(input: unknown): CompiledSftpIndexerConfig {
  const config = sftpIndexerConfigSchema.parse(input);
  const extraDenyByRoot = new Map<string, readonly DenyRule[]>();

  for (const server of config.servers) {
    for (const root of server.roots) {
      if (root.extraDenyPatterns !== undefined && root.extraDenyPatterns.length > 0) {
        extraDenyByRoot.set(
          server.id + ':' + root.path,
          compileExtraDenyPatterns(root.extraDenyPatterns),
        );
      }
    }
  }
  for (const server of config.servers) {
    validateLiveServer(server, extraDenyByRoot);
  }
  return { config, extraDenyByRoot };
}
