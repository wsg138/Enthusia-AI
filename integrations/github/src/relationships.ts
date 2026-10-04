/**
 * @enthusia/integration-github — derived entity relationships (W08).
 *
 * The code-graph relationships required by WORKER-EXECUTION-PLAN.md §11
 * and MASTER-SPECIFICATION.md §23.3 / §40:
 *
 * - repo -> plugin/component       (REPO_BUILDS_PLUGIN)
 * - plugin -> commands              (PLUGIN_DEFINES_COMMAND)
 * - command -> permission           (COMMAND_REQUIRES_PERMISSION)
 * - plugin -> permissions           (PLUGIN_DEFINES_PERMISSION)
 * - file -> source SHA              (FILE_HAS_SHA, implicit in every artifact)
 *
 * Relationships are emitted by the indexer as part of each run report and
 * are ALSO indexed as a per-repo summary artifact so they are retrievable
 * through normal knowledge search.
 *
 * Entity ID conventions (stable, human-readable):
 * - repo:       `github:<owner>/<repo>`
 * - plugin:     `plugin:<name>@<version>`
 * - command:    `command:/<name>`
 * - permission: `permission:<node>`
 * - file:       `github:<owner>/<repo>:<path>` (the artifact locator)
 */

import type { PluginManifest } from './parsers.js';

export type RelationshipType =
  | 'REPO_BUILDS_PLUGIN'
  | 'PLUGIN_DEFINES_COMMAND'
  | 'COMMAND_REQUIRES_PERMISSION'
  | 'PLUGIN_DEFINES_PERMISSION'
  | 'FILE_HAS_SHA';

export interface EntityRelationship {
  type: RelationshipType;
  /** Source entity id. */
  from: string;
  /** Target entity id. */
  to: string;
  /** Free-form supporting detail (e.g. command description). */
  detail?: string;
}

export function pluginEntityId(manifest: Pick<PluginManifest, 'name' | 'version'>): string {
  return `plugin:${manifest.name}@${manifest.version}`;
}

export function commandEntityId(name: string): string {
  return `command:/${name.replace(/^\//, '')}`;
}

export function permissionEntityId(node: string): string {
  return `permission:${node}`;
}

export function repoEntityId(owner: string, repo: string): string {
  return `github:${owner}/${repo}`;
}

export function fileEntityId(owner: string, repo: string, path: string): string {
  return `github:${owner}/${repo}:${path}`;
}

/**
 * Derive the entity graph for one parsed plugin manifest.
 * Emits REPO_BUILDS_PLUGIN, PLUGIN_DEFINES_COMMAND,
 * COMMAND_REQUIRES_PERMISSION, and PLUGIN_DEFINES_PERMISSION edges.
 */
export function relationshipsForManifest(
  owner: string,
  repo: string,
  manifest: PluginManifest,
): EntityRelationship[] {
  const rels: EntityRelationship[] = [];
  const repoId = repoEntityId(owner, repo);
  const pluginId = pluginEntityId(manifest);

  rels.push({
    type: 'REPO_BUILDS_PLUGIN',
    from: repoId,
    to: pluginId,
    detail: `manifest format: ${manifest.format}`,
  });

  for (const cmd of manifest.commands) {
    const cmdId = commandEntityId(cmd.name);
    const rel: EntityRelationship = {
      type: 'PLUGIN_DEFINES_COMMAND',
      from: pluginId,
      to: cmdId,
    };
    if (cmd.description !== undefined) rel.detail = cmd.description;
    rels.push(rel);
    if (cmd.permission !== undefined) {
      rels.push({
        type: 'COMMAND_REQUIRES_PERMISSION',
        from: cmdId,
        to: permissionEntityId(cmd.permission),
      });
    }
  }

  for (const perm of manifest.permissions) {
    const rel: EntityRelationship = {
      type: 'PLUGIN_DEFINES_PERMISSION',
      from: pluginId,
      to: permissionEntityId(perm.node),
    };
    if (perm.description !== undefined) rel.detail = perm.description;
    rels.push(rel);
  }

  return rels;
}

/**
 * Render relationships as indexable text for the per-repo summary
 * artifact. One line per edge — trivially greppable.
 */
export function renderRelationshipsText(relationships: EntityRelationship[]): string {
  return relationships
    .map((r) => {
      const detail = r.detail !== undefined ? ` # ${r.detail}` : '';
      return `${r.type}: ${r.from} -> ${r.to}${detail}`;
    })
    .join('\n');
}
