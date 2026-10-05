import {
  findConfiguredRoot,
  type CompiledSftpIndexerConfig,
  type SftpServerConfig,
} from './config.js';
import type { DenyRule } from './deny.js';
import { LiveBoundaryError } from './live-errors.js';

export function extraRulesFor(
  compiled: CompiledSftpIndexerConfig,
  server: SftpServerConfig,
  path: string,
): readonly DenyRule[] {
  const root = findConfiguredRoot(server, path);
  if (root === undefined) throw new LiveBoundaryError('PATH_DENIED', false);
  return compiled.extraDenyByRoot.get(server.id + ':' + root.path) ?? [];
}
