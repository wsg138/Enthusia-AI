/**
 * @enthusia/integration-databases — closed query-template registry (W10).
 *
 * This is the core safety mechanism of the database tools.
 *
 * The model NEVER supplies SQL. The only SQL text that can ever reach a
 * database driver is one of the templates registered below. Model-controlled
 * input only ever becomes bound parameter VALUES (see connection.ts, which
 * rejects non-scalar params and verifies the placeholder count).
 *
 * There is deliberately NO public function that accepts SQL text anywhere in
 * this package. `getQueryTemplate` accepts only a registry key; unknown keys
 * throw `UNKNOWN_QUERY_TEMPLATE`.
 *
 * Every template is validated at module load:
 * - single SELECT statement (no `;`, no stacked statements);
 * - no SQL comments (`--`, `/*`) and no string literals (every `?` is a true
 *   parameter placeholder, so a hostile value can never break out of a literal);
 * - no write/DDL keywords (INSERT/UPDATE/DELETE/DROP/...) as whole words;
 * - declared paramCount matches the actual `?` count.
 */

export const QUERY_TEMPLATE_NAMES = [
  'linkedAccount',
  'playerRank',
  'permissionState',
  'ticketMetadata',
  'economyFact',
] as const;

export type QueryTemplateName = (typeof QUERY_TEMPLATE_NAMES)[number];

export interface QueryTemplate {
  readonly name: QueryTemplateName;
  readonly description: string;
  /**
   * The ONLY SQL this template may execute. Single SELECT, `?` placeholders,
   * no comments, no string literals.
   */
  readonly sql: string;
  readonly paramCount: number;
}

/** Machine-readable template registry failure. */
export class QueryTemplateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'QueryTemplateError';
    this.code = code;
  }
}

const WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|call|execute|handler|load\s+data|lock\s+tables|unlock\s+tables|into\s+(outfile|dumpfile))\b/i;
const COMMENT_TOKEN = /--|\/\*/;
const SELECT_SIDE_EFFECT = /\b(?:into|for\s+update|lock\s+in\s+share\s+mode)\b/i;

/**
 * Defense-in-depth static check applied to every registered template at
 * module load. Throws TEMPLATE_VALIDATION_FAILED on the first problem.
 */
export function assertTemplateSafe(template: QueryTemplate): void {
  const sql = template.sql.trim();
  if (!/^select\b/i.test(sql)) {
    throw new QueryTemplateError(
      'TEMPLATE_VALIDATION_FAILED',
      `template ${template.name}: must be a single SELECT statement`,
    );
  }
  if (sql.includes(';')) {
    throw new QueryTemplateError(
      'TEMPLATE_VALIDATION_FAILED',
      `template ${template.name}: stacked statements are not allowed`,
    );
  }
  if (COMMENT_TOKEN.test(sql)) {
    throw new QueryTemplateError(
      'TEMPLATE_VALIDATION_FAILED',
      `template ${template.name}: SQL comments are not allowed`,
    );
  }
  if (sql.includes("'") || sql.includes('"') || sql.includes('`')) {
    throw new QueryTemplateError(
      'TEMPLATE_VALIDATION_FAILED',
      `template ${template.name}: string literals are not allowed; use ? placeholders`,
    );
  }
  if (WRITE_KEYWORDS.test(sql) || SELECT_SIDE_EFFECT.test(sql)) {
    throw new QueryTemplateError(
      'TEMPLATE_VALIDATION_FAILED',
      `template ${template.name}: write/locking/INTO clauses are not allowed`,
    );
  }
  const placeholders = (sql.match(/\?/g) ?? []).length;
  if (placeholders !== template.paramCount) {
    throw new QueryTemplateError(
      'TEMPLATE_VALIDATION_FAILED',
      `template ${template.name}: declares ${template.paramCount} params but SQL has ${placeholders} placeholders`,
    );
  }
}

const LINKED_ACCOUNT: QueryTemplate = {
  name: 'linkedAccount',
  description: 'Resolve a Discord user ID to the linked Minecraft account.',
  sql: 'SELECT minecraft_uuid, minecraft_username, linked_at, link_source FROM account_links WHERE discord_id = ? LIMIT 2',
  paramCount: 1,
};

const PLAYER_RANK: QueryTemplate = {
  name: 'playerRank',
  description: 'Current (unexpired) rank of a Minecraft player, newest grant first.',
  sql: 'SELECT rank_id, rank_name, granted_at, expires_at, granted_by FROM player_ranks WHERE player_uuid = ? AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP()) ORDER BY granted_at DESC LIMIT 2',
  paramCount: 1,
};

const PERMISSION_STATE: QueryTemplate = {
  name: 'permissionState',
  description: 'Effective granted/denied state of one permission node for a player.',
  sql: 'SELECT permission_node, granted, source FROM effective_permissions WHERE player_uuid = ? AND permission_node = ? LIMIT 2',
  paramCount: 2,
};

const TICKET_METADATA: QueryTemplate = {
  name: 'ticketMetadata',
  description: 'Ticket status and subject. Subject visibility is filtered per-row at the tool layer.',
  sql: 'SELECT ticket_id, status, subject, subject_visibility, requester_id, requester_uuid, created_at, updated_at FROM tickets WHERE ticket_id = ? LIMIT 2',
  paramCount: 1,
};

const ECONOMY_FACT: QueryTemplate = {
  name: 'economyFact',
  description: 'One approved economy fact for a player. Only allowlisted fact keys are queryable.',
  sql: 'SELECT fact_key, fact_value, observed_at FROM economy_facts WHERE player_uuid = ? AND fact_key = ? LIMIT 2',
  paramCount: 2,
};

const REGISTRY: Record<QueryTemplateName, QueryTemplate> = {
  linkedAccount: LINKED_ACCOUNT,
  playerRank: PLAYER_RANK,
  permissionState: PERMISSION_STATE,
  ticketMetadata: TICKET_METADATA,
  economyFact: ECONOMY_FACT,
};

// Validate every template once at module load — fail fast, never serve an
// unsafe template.
for (const template of Object.values(REGISTRY)) {
  assertTemplateSafe(template);
}

/** Fetch a registered template by name. Unknown names throw UNKNOWN_QUERY_TEMPLATE. */
export function getQueryTemplate(name: string): QueryTemplate {
  const template = (REGISTRY as Record<string, QueryTemplate | undefined>)[name];
  if (template === undefined) {
    throw new QueryTemplateError(
      'UNKNOWN_QUERY_TEMPLATE',
      `unknown query template: ${name}`,
    );
  }
  return template;
}

/** All registered template names, in registry order. */
export function listQueryTemplateNames(): QueryTemplateName[] {
  return [...QUERY_TEMPLATE_NAMES];
}
