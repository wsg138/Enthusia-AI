/**
 * @enthusia/integration-databases — schema descriptions for the approved read surfaces (W10).
 *
 * Spec: MASTER-SPECIFICATION.md §25.1 (schema indexing: table names, columns,
 * relationships, descriptions, ownership/component mapping).
 *
 * These descriptions feed the W04 source registry / W07 knowledge index as
 * DATABASE_SCHEMA artifacts. They describe the SHAPE of the approved read
 * views only — never live rows. Live data flows exclusively through the
 * purpose-built tools in tools.ts (§25.2).
 *
 * Physical table names may differ per deployment; the templates in
 * query-templates.ts are the binding contract for what the tools actually
 * read.
 */
import { Visibility } from '@enthusia/contracts';

export interface ColumnDescription {
  readonly name: string;
  readonly type: string;
  readonly description: string;
}

export interface TableDescription {
  readonly name: string;
  readonly description: string;
  /** Owning component/plugin, for the entity graph (§40). */
  readonly owner: string;
  readonly columns: readonly ColumnDescription[];
  /** Most sensitive visibility any row of this surface may carry. */
  readonly maxVisibility: Visibility;
  /** Which tool(s) read this surface. */
  readonly readByTools: readonly string[];
}

export const DATABASE_SCHEMA: readonly TableDescription[] = [
  {
    name: 'account_links',
    description:
      'Discord-to-Minecraft account linkage. One row per linked Discord user.',
    owner: 'account-linking service',
    maxVisibility: Visibility.PLAYER_SELF,
    readByTools: ['db.resolve_linked_account'],
    columns: [
      { name: 'discord_id', type: 'VARCHAR(32)', description: 'Discord user ID (snowflake as text).' },
      { name: 'minecraft_uuid', type: 'CHAR(36)', description: 'Linked Minecraft player UUID (canonical hyphenated form).' },
      { name: 'minecraft_username', type: 'VARCHAR(16)', description: 'Username at link time; informational only, UUID is the identity.' },
      { name: 'linked_at', type: 'TIMESTAMP', description: 'When the link was established.' },
      { name: 'link_source', type: 'VARCHAR(32)', description: 'How the link was created (e.g. discord-command, web-oauth).' },
    ],
  },
  {
    name: 'player_ranks',
    description:
      'Rank grants per player. History is retained; "current rank" means the newest unexpired grant.',
    owner: 'rank system (LuckPerms groups via Tebex)',
    maxVisibility: Visibility.PLAYER_SELF,
    readByTools: ['db.get_player_rank'],
    columns: [
      { name: 'player_uuid', type: 'CHAR(36)', description: 'Minecraft player UUID.' },
      { name: 'rank_id', type: 'VARCHAR(64)', description: 'Internal rank identifier.' },
      { name: 'rank_name', type: 'VARCHAR(64)', description: 'Display name of the rank.' },
      { name: 'granted_at', type: 'TIMESTAMP', description: 'When the grant took effect.' },
      { name: 'expires_at', type: 'TIMESTAMP NULL', description: 'Null for permanent grants.' },
      { name: 'granted_by', type: 'VARCHAR(64)', description: 'Grant origin (tebex, staff uuid, console).' },
    ],
  },
  {
    name: 'effective_permissions',
    description:
      'Materialized effective permission state per player: the live answer to "does this player have this node".',
    owner: 'permission service',
    maxVisibility: Visibility.PLAYER_SELF,
    readByTools: ['db.get_permission_state'],
    columns: [
      { name: 'player_uuid', type: 'CHAR(36)', description: 'Minecraft player UUID.' },
      { name: 'permission_node', type: 'VARCHAR(128)', description: 'Dotted permission node, e.g. enthusia.trade.' },
      { name: 'granted', type: 'BOOLEAN', description: 'Effective state after rank/group inheritance.' },
      { name: 'source', type: 'VARCHAR(64)', description: 'Where the grant comes from (rank id, direct grant, default).' },
    ],
  },
  {
    name: 'tickets',
    description:
      'Support ticket metadata. The AI reads metadata only; lifecycle authority stays with the Ticket Bot (§5.8).',
    owner: 'ticket system',
    maxVisibility: Visibility.STAFF,
    readByTools: ['db.get_ticket_metadata'],
    columns: [
      { name: 'ticket_id', type: 'VARCHAR(32)', description: 'Ticket identifier.' },
      { name: 'status', type: 'VARCHAR(32)', description: 'Lifecycle state (open, pending, closed, ...).' },
      { name: 'subject', type: 'TEXT', description: 'Ticket subject; visibility-filtered per row by subject_visibility.' },
      { name: 'subject_visibility', type: 'VARCHAR(16)', description: 'Visibility class of the subject (PUBLIC/PLAYER_SELF/STAFF).' },
      { name: 'requester_id', type: 'VARCHAR(64)', description: 'Actor identity of the ticket requester.' },
      { name: 'requester_uuid', type: 'CHAR(36) NULL', description: 'Linked Minecraft UUID of the requester, when known.' },
      { name: 'created_at', type: 'TIMESTAMP', description: 'Ticket creation time.' },
      { name: 'updated_at', type: 'TIMESTAMP', description: 'Last state change.' },
    ],
  },
  {
    name: 'economy_facts',
    description:
      'Approved economy facts per player (key/value). Only allowlisted fact keys are exposed — see ECONOMY_FACT_TYPES in tools.ts.',
    owner: 'economy system',
    maxVisibility: Visibility.PLAYER_SELF,
    readByTools: ['db.get_economy_fact'],
    columns: [
      { name: 'player_uuid', type: 'CHAR(36)', description: 'Minecraft player UUID.' },
      { name: 'fact_key', type: 'VARCHAR(64)', description: 'Allowlisted fact key, e.g. balance.' },
      { name: 'fact_value', type: 'TEXT', description: 'Fact value as text; typed by the tool per fact key.' },
      { name: 'observed_at', type: 'TIMESTAMP', description: 'When this fact was last computed.' },
    ],
  },
];

/**
 * Schema descriptions for indexers (W04/W07). Returns the canonical,
 * deployment-independent shape of every approved read surface.
 */
export function describeSchema(): readonly TableDescription[] {
  return DATABASE_SCHEMA;
}

/** Find one surface description by (view) name. */
export function describeTable(name: string): TableDescription | undefined {
  return DATABASE_SCHEMA.find((table) => table.name === name);
}
