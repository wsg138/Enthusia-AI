/**
 * @enthusia/integration-databases — the five purpose-built database tools (W10).
 *
 * Spec: MASTER-SPECIFICATION.md §16.1 (database: read-only purpose-built
 * queries — player account lookup, permission/rank lookup, economy history if
 * approved, ticket metadata), §16.2 (provenance), §17 (visibility), §25.2
 * (live data through purpose-built read tools).
 *
 * Each tool:
 * - validates params with zod (hostile input is rejected or becomes a bound
 *   parameter value — never SQL);
 * - executes exactly one registered query template (see query-templates.ts);
 * - validates row shapes before mapping them to typed payloads;
 * - enforces visibility (§17) with canDisclose, including PLAYER_SELF
 *   identity checks and per-row subject filtering for tickets;
 * - returns a ToolResult envelope with full provenance (toolName, timestamp,
 *   source, visibility, correlationId, freshness).
 *
 * These tools plug into W12's ToolRegistry: they implement the Tool interface
 * shape mirrored in tool-adapter.ts. DO NOT modify W12's code.
 */
import { z } from 'zod';
import {
  Visibility,
  canDisclose,
  visibilityRank,
} from '@enthusia/contracts';
import type { Actor, ToolResult } from '@enthusia/contracts';
import type { DatabaseConnectionManager } from './connection.js';
import { DbManagerError } from './connection.js';
import type { QueryTemplateName } from './query-templates.js';
import type { DbRow } from './client.js';
import {
  buildToolError,
  buildToolResult,
} from './provenance.js';
import type { DatabaseFreshness } from './provenance.js';
import {
  DatabaseTool,
  type Tool,
  type ToolCallContext,
  type ToolMetadata,
  type ToolParameterProperty,
  type ToolParametersSchema,
} from './tool-adapter.js';

/* ------------------------------------------------------------------ */
/* Shared param/row validation                                         */
/* ------------------------------------------------------------------ */

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'must be a canonical UUID (8-4-4-4-12 hex)',
  );

const discordIdSchema = z
  .string()
  .regex(/^\d{5,20}$/, 'discordId must be a 5-20 digit Discord snowflake');

const permissionNodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'permissionNode may only contain letters, digits, dots, underscores, hyphens',
  );

const ticketIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, 'ticketId may only contain letters, digits, _ and -');

/**
 * Approved economy facts ONLY (§16.1 "economy history if approved"). Any other
 * factType is rejected at the zod boundary — the model cannot invent new
 * economy queries.
 */
export const ECONOMY_FACT_TYPES = [
  'balance',
  'lifetime_earned',
  'lifetime_spent',
  'last_transaction_at',
] as const;
export type EconomyFactType = (typeof ECONOMY_FACT_TYPES)[number];
const economyFactTypeSchema = z.enum(ECONOMY_FACT_TYPES);

function zodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`)
    .join('; ');
}

function stringProp(
  description: string,
  extra?: Partial<ToolParameterProperty>,
): ToolParameterProperty {
  return { type: 'string', description, ...extra };
}

function paramsSchema(
  properties: Record<string, ToolParameterProperty>,
  required: string[],
): ToolParametersSchema {
  return { type: 'object', properties, required };
}

function isStaffLike(actor: Actor): boolean {
  return actor.type === 'staff' || actor.type === 'system';
}

/* ------------------------------------------------------------------ */
/* Base class wiring manager + envelope                                */
/* ------------------------------------------------------------------ */

interface ToolRuntime {
  manager: DatabaseConnectionManager;
}

abstract class W10Tool<
  TParams extends Record<string, unknown>,
> extends DatabaseTool<TParams> {
  constructor(protected readonly runtime: ToolRuntime) {
    super();
  }

  protected async runTemplate(
    templateName: QueryTemplateName,
    params: readonly unknown[],
    ctx: ToolCallContext,
  ): Promise<{ rows: DbRow[]; truncated: boolean }> {
    const executed = await this.runtime.manager.executeTemplate(
      templateName,
      params,
      ctx.signal === undefined ? {} : { signal: ctx.signal },
    );
    return { rows: executed.rows, truncated: executed.truncated };
  }

  protected ok<T>(
    ctx: ToolCallContext,
    args: {
      source: string;
      visibility: Visibility;
      result: T;
      templateName: QueryTemplateName;
      rowCount: number;
      truncated: boolean;
    },
  ): ToolResult<T> {
    const freshness: DatabaseFreshness = {
      observedAt: new Date().toISOString(),
      sourceStatus: 'CURRENT',
      queryTemplate: args.templateName,
      rowCount: args.rowCount,
      truncated: args.truncated,
    };
    return buildToolResult<T>(
      {
        toolName: this.meta.name,
        source: args.source,
        visibility: args.visibility,
        correlationId: ctx.traceId,
        freshness,
      },
      args.result,
    );
  }

  protected fail(
    ctx: ToolCallContext,
    args: {
      source: string;
      visibility: Visibility;
      code: string;
      message: string;
      retryable: boolean;
    },
  ): ToolResult<never> {
    return buildToolError(
      {
        toolName: this.meta.name,
        source: args.source,
        visibility: args.visibility,
        correlationId: ctx.traceId,
      },
      { code: args.code, message: args.message, retryable: args.retryable },
    );
  }

  /** Map manager/driver failures into the ToolResult error envelope. */
  protected failFromDbError(
    ctx: ToolCallContext,
    source: string,
    visibility: Visibility,
    error: unknown,
  ): ToolResult<never> {
    if (error instanceof DbManagerError) {
      return this.fail(ctx, {
        source,
        visibility,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
    }
    return this.fail(ctx, {
      source,
      visibility,
      code: 'DB_QUERY_FAILED',
      message: 'database query failed',
      retryable: false,
    });
  }

  protected invalidParams(
    ctx: ToolCallContext,
    source: string,
    error: z.ZodError,
  ): ToolResult<never> {
    return this.fail(ctx, {
      source,
      visibility: this.meta.maxVisibility,
      code: 'INVALID_TOOL_PARAMS',
      message: `invalid params: ${zodIssues(error)}`,
      retryable: false,
    });
  }

  protected rowShapeError(
    ctx: ToolCallContext,
    source: string,
    error: z.ZodError,
  ): ToolResult<never> {
    return this.fail(ctx, {
      source,
      visibility: this.meta.maxVisibility,
      code: 'DB_ROW_SHAPE',
      message: `unexpected database row shape: ${zodIssues(error)}`,
      retryable: false,
    });
  }

  protected ambiguousRows(
    ctx: ToolCallContext,
    source: string,
    rowCount: number,
  ): ToolResult<never> {
    return this.fail(ctx, {
      source,
      visibility: this.meta.maxVisibility,
      code: 'AMBIGUOUS_DB_RESULT',
      message: `expected at most one row, received ${rowCount}`,
      retryable: false,
    });
  }
}

/* ------------------------------------------------------------------ */
/* db.resolve_linked_account                                         */
/* ------------------------------------------------------------------ */

export type ResolveLinkedAccountParams = { discordId: string };
export type LinkedAccountResult =
  | {
      found: true;
      discordId: string;
      minecraftUuid: string;
      minecraftUsername: string;
      linkedAt: string;
      linkSource: string;
    }
  | { found: false; discordId: string };

const linkedAccountParamsSchema = z.object({ discordId: discordIdSchema });
const linkedAccountRowSchema = z.object({
  minecraft_uuid: uuidSchema,
  minecraft_username: z.string(),
  linked_at: z.unknown(),
  link_source: z.string(),
});

class ResolveLinkedAccountTool extends W10Tool<ResolveLinkedAccountParams> {
  readonly meta: ToolMetadata = {
    name: 'db.resolve_linked_account',
    description:
      'Resolve a Discord user ID to the linked Minecraft account (UUID, username, link time). PLAYER_SELF visibility.',
    parameters: paramsSchema(
      { discordId: stringProp('Discord user ID (snowflake, digits only).') },
      ['discordId'],
    ),
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: Visibility.PLAYER_SELF,
  };


  async execute(
    params: ResolveLinkedAccountParams,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const source = 'database:live:account_links';
    const parsed = linkedAccountParamsSchema.safeParse(params);
    if (!parsed.success) return this.invalidParams(ctx, source, parsed.error);
    const { discordId } = parsed.data;

    let query;
    try {
      query = await this.runTemplate('linkedAccount', [discordId], ctx);
    } catch (error) {
      return this.failFromDbError(ctx, source, this.meta.maxVisibility, error);
    }

    if (query.rows.length > 1) return this.ambiguousRows(ctx, source, query.rows.length);
    const firstRow = query.rows[0];
    let result: LinkedAccountResult;
    if (firstRow === undefined) {
      result = { found: false, discordId };
    } else {
      const row = linkedAccountRowSchema.safeParse(firstRow);
      if (!row.success) return this.rowShapeError(ctx, source, row.error);
      result = {
        found: true,
        discordId,
        minecraftUuid: row.data.minecraft_uuid,
        minecraftUsername: row.data.minecraft_username,
        linkedAt: String(row.data.linked_at),
        linkSource: row.data.link_source,
      };
    }

    // PLAYER_SELF: disclosable to the subject player or authorized staff.
    const isSubject =
      ctx.actor.id === discordId ||
      (result.found === true && ctx.actor.linkedUuid === result.minecraftUuid);
    if (
      !canDisclose(Visibility.PLAYER_SELF, ctx.visibilityCeiling, {
        isSubject,
        isStaff: isStaffLike(ctx.actor),
      })
    ) {
      return this.fail(ctx, {
        source,
        visibility: this.meta.maxVisibility,
        code: 'VISIBILITY_DENIED',
        message: 'linked account is not disclosable to this actor',
        retryable: false,
      });
    }

    return this.ok<LinkedAccountResult>(ctx, {
      source,
      visibility: Visibility.PLAYER_SELF,
      result,
      templateName: 'linkedAccount',
      rowCount: query.rows.length,
      truncated: query.truncated,
    });
  }
}

/* ------------------------------------------------------------------ */
/* db.get_player_rank                                                */
/* ------------------------------------------------------------------ */

export type GetPlayerRankParams = { playerUuid: string };
export type PlayerRankResult =
  | {
      found: true;
      playerUuid: string;
      rankId: string;
      rankName: string;
      grantedAt: string;
      expiresAt: string | null;
      grantedBy: string;
    }
  | { found: false; playerUuid: string };

const playerRankParamsSchema = z.object({ playerUuid: uuidSchema });
const playerRankRowSchema = z.object({
  rank_id: z.string(),
  rank_name: z.string(),
  granted_at: z.unknown(),
  expires_at: z.unknown().nullable(),
  granted_by: z.string(),
});

class GetPlayerRankTool extends W10Tool<GetPlayerRankParams> {
  readonly meta: ToolMetadata = {
    name: 'db.get_player_rank',
    description:
      'Current (unexpired) rank of a Minecraft player. PLAYER_SELF visibility.',
    parameters: paramsSchema(
      { playerUuid: stringProp('Canonical Minecraft player UUID.') },
      ['playerUuid'],
    ),
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: Visibility.PLAYER_SELF,
  };


  async execute(
    params: GetPlayerRankParams,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const source = 'database:live:player_ranks';
    const parsed = playerRankParamsSchema.safeParse(params);
    if (!parsed.success) return this.invalidParams(ctx, source, parsed.error);
    const { playerUuid } = parsed.data;

    let query;
    try {
      query = await this.runTemplate('playerRank', [playerUuid], ctx);
    } catch (error) {
      return this.failFromDbError(ctx, source, this.meta.maxVisibility, error);
    }

    const firstRow = query.rows[0];
    let result: PlayerRankResult;
    if (firstRow === undefined) {
      result = { found: false, playerUuid };
    } else {
      const row = playerRankRowSchema.safeParse(firstRow);
      if (!row.success) return this.rowShapeError(ctx, source, row.error);
      result = {
        found: true,
        playerUuid,
        rankId: row.data.rank_id,
        rankName: row.data.rank_name,
        grantedAt: String(row.data.granted_at),
        expiresAt:
          row.data.expires_at === null ? null : String(row.data.expires_at),
        grantedBy: row.data.granted_by,
      };
    }

    const isSubject =
      ctx.actor.id === playerUuid || ctx.actor.linkedUuid === playerUuid;
    if (
      !canDisclose(Visibility.PLAYER_SELF, ctx.visibilityCeiling, {
        isSubject,
        isStaff: isStaffLike(ctx.actor),
      })
    ) {
      return this.fail(ctx, {
        source,
        visibility: this.meta.maxVisibility,
        code: 'VISIBILITY_DENIED',
        message: 'player rank is not disclosable to this actor',
        retryable: false,
      });
    }

    return this.ok<PlayerRankResult>(ctx, {
      source,
      visibility: Visibility.PLAYER_SELF,
      result,
      templateName: 'playerRank',
      rowCount: query.rows.length,
      truncated: query.truncated,
    });
  }
}

/* ------------------------------------------------------------------ */
/* db.get_permission_state                                           */
/* ------------------------------------------------------------------ */

export type GetPermissionStateParams = {
  playerUuid: string;
  permissionNode: string;
};
export type PermissionStateResult =
  | {
      found: true;
      playerUuid: string;
      permissionNode: string;
      granted: boolean;
      source: string;
    }
  | {
      found: false;
      playerUuid: string;
      permissionNode: string;
    };

const permissionStateParamsSchema = z.object({
  playerUuid: uuidSchema,
  permissionNode: permissionNodeSchema,
});
const permissionStateRowSchema = z.object({
  permission_node: z.string(),
  granted: z.union([z.boolean(), z.number().int()]),
  source: z.string(),
});

class GetPermissionStateTool extends W10Tool<GetPermissionStateParams> {
  readonly meta: ToolMetadata = {
    name: 'db.get_permission_state',
    description:
      'Effective state of one permission node for a player. A missing row is returned as unknown/not found, never inferred as denied. PLAYER_SELF visibility.',
    parameters: paramsSchema(
      {
        playerUuid: stringProp('Canonical Minecraft player UUID.'),
        permissionNode: stringProp(
          'Dotted permission node, e.g. enthusia.trade.',
        ),
      },
      ['playerUuid', 'permissionNode'],
    ),
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: Visibility.PLAYER_SELF,
  };


  async execute(
    params: GetPermissionStateParams,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const source = 'database:live:effective_permissions';
    const parsed = permissionStateParamsSchema.safeParse(params);
    if (!parsed.success) return this.invalidParams(ctx, source, parsed.error);
    const { playerUuid, permissionNode } = parsed.data;

    let query;
    try {
      query = await this.runTemplate(
        'permissionState',
        [playerUuid, permissionNode],
        ctx,
      );
    } catch (error) {
      return this.failFromDbError(ctx, source, this.meta.maxVisibility, error);
    }

    if (query.rows.length > 1) return this.ambiguousRows(ctx, source, query.rows.length);
    const firstRow = query.rows[0];
    let result: PermissionStateResult;
    if (firstRow === undefined) {
      result = { found: false, playerUuid, permissionNode };
    } else {
      const row = permissionStateRowSchema.safeParse(firstRow);
      if (!row.success) return this.rowShapeError(ctx, source, row.error);
      const granted =
        typeof row.data.granted === 'boolean'
          ? row.data.granted
          : row.data.granted !== 0;
      result = {
        found: true,
        playerUuid,
        permissionNode: row.data.permission_node,
        granted,
        source: row.data.source,
      };
    }

    const isSubject =
      ctx.actor.id === playerUuid || ctx.actor.linkedUuid === playerUuid;
    if (
      !canDisclose(Visibility.PLAYER_SELF, ctx.visibilityCeiling, {
        isSubject,
        isStaff: isStaffLike(ctx.actor),
      })
    ) {
      return this.fail(ctx, {
        source,
        visibility: this.meta.maxVisibility,
        code: 'VISIBILITY_DENIED',
        message: 'permission state is not disclosable to this actor',
        retryable: false,
      });
    }

    return this.ok<PermissionStateResult>(ctx, {
      source,
      visibility: Visibility.PLAYER_SELF,
      result,
      templateName: 'permissionState',
      rowCount: query.rows.length,
      truncated: query.truncated,
    });
  }
}

/* ------------------------------------------------------------------ */
/* db.get_ticket_metadata                                            */
/* ------------------------------------------------------------------ */

export type GetTicketMetadataParams = { ticketId: string };
export interface TicketMetadataResult {
  ticketId: string;
  status: string;
  /** Null when the subject is not disclosable to this actor. */
  subject: string | null;
  subjectRedacted: boolean;
  createdAt: string;
  updatedAt: string;
}

const ticketMetadataParamsSchema = z.object({ ticketId: ticketIdSchema });
const ticketMetadataRowSchema = z.object({
  ticket_id: z.string(),
  status: z.string(),
  subject: z.string(),
  subject_visibility: z.nativeEnum(Visibility),
  requester_id: z.string(),
  requester_uuid: z.string().nullable(),
  created_at: z.unknown(),
  updated_at: z.unknown(),
});

class GetTicketMetadataTool extends W10Tool<GetTicketMetadataParams> {
  readonly meta: ToolMetadata = {
    name: 'db.get_ticket_metadata',
    description:
      'Ticket status and subject. The subject is visibility-filtered per row: redacted unless disclosable to the actor. Requester and staff only.',
    parameters: paramsSchema(
      { ticketId: stringProp('Ticket identifier.') },
      ['ticketId'],
    ),
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: Visibility.STAFF,
  };


  async execute(
    params: GetTicketMetadataParams,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const source = 'database:live:tickets';
    const parsed = ticketMetadataParamsSchema.safeParse(params);
    if (!parsed.success) return this.invalidParams(ctx, source, parsed.error);
    const { ticketId } = parsed.data;

    let query;
    try {
      query = await this.runTemplate('ticketMetadata', [ticketId], ctx);
    } catch (error) {
      return this.failFromDbError(ctx, source, this.meta.maxVisibility, error);
    }

    if (query.rows.length > 1) return this.ambiguousRows(ctx, source, query.rows.length);
    const firstRow = query.rows[0];
    if (firstRow === undefined) {
      return this.fail(ctx, {
        source,
        visibility: Visibility.STAFF,
        code: 'NOT_FOUND',
        message: `ticket not found: ${ticketId}`,
        retryable: false,
      });
    }
    const row = ticketMetadataRowSchema.safeParse(firstRow);
    if (!row.success) return this.rowShapeError(ctx, source, row.error);
    const ticket = row.data;

    const staff = isStaffLike(ctx.actor);
    const isRequester =
      ctx.actor.id === ticket.requester_id ||
      (ctx.actor.linkedUuid !== undefined &&
        ticket.requester_uuid !== null &&
        ctx.actor.linkedUuid === ticket.requester_uuid);

    // Base metadata: staff see it at STAFF; the requester at PLAYER_SELF.
    // Anyone else gets nothing (no ticket-existence oracle for strangers).
    const baseVisibility = staff ? Visibility.STAFF : Visibility.PLAYER_SELF;
    if (
      !canDisclose(baseVisibility, ctx.visibilityCeiling, {
        isSubject: isRequester,
        isStaff: staff,
      })
    ) {
      return this.fail(ctx, {
        source,
        visibility: Visibility.STAFF,
        code: 'VISIBILITY_DENIED',
        message: 'ticket metadata is not disclosable to this actor',
        retryable: false,
      });
    }

    // Per-row subject filtering.
    const subjectDisclosable = canDisclose(
      ticket.subject_visibility,
      ctx.visibilityCeiling,
      { isSubject: isRequester, isStaff: staff },
    );
    const result: TicketMetadataResult = {
      ticketId: ticket.ticket_id,
      status: ticket.status,
      subject: subjectDisclosable ? ticket.subject : null,
      subjectRedacted: !subjectDisclosable,
      createdAt: String(ticket.created_at),
      updatedAt: String(ticket.updated_at),
    };
    const resultVisibility =
      subjectDisclosable &&
      visibilityRank(ticket.subject_visibility) > visibilityRank(baseVisibility)
        ? ticket.subject_visibility
        : baseVisibility;

    return this.ok<TicketMetadataResult>(ctx, {
      source,
      visibility: resultVisibility,
      result,
      templateName: 'ticketMetadata',
      rowCount: query.rows.length,
      truncated: query.truncated,
    });
  }
}

/* ------------------------------------------------------------------ */
/* db.get_economy_fact                                               */
/* ------------------------------------------------------------------ */

export type GetEconomyFactParams = {
  playerUuid: string;
  factType: EconomyFactType;
};
export type EconomyFactResult =
  | {
      found: true;
      playerUuid: string;
      factType: EconomyFactType;
      value: string;
      observedAt: string;
    }
  | { found: false; playerUuid: string; factType: EconomyFactType };

const economyFactParamsSchema = z.object({
  playerUuid: uuidSchema,
  factType: economyFactTypeSchema,
});
const economyFactRowSchema = z.object({
  fact_key: z.string(),
  fact_value: z.unknown(),
  observed_at: z.unknown(),
});

class GetEconomyFactTool extends W10Tool<GetEconomyFactParams> {
  readonly meta: ToolMetadata = {
    name: 'db.get_economy_fact',
    description:
      'One approved economy fact for a player (balance, lifetime_earned, lifetime_spent, last_transaction_at). Only allowlisted fact types are queryable. PLAYER_SELF visibility.',
    parameters: paramsSchema(
      {
        playerUuid: stringProp('Canonical Minecraft player UUID.'),
        factType: stringProp('Approved economy fact key.', {
          enum: [...ECONOMY_FACT_TYPES],
        }),
      },
      ['playerUuid', 'factType'],
    ),
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: Visibility.PLAYER_SELF,
  };

  async execute(
    params: GetEconomyFactParams,
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const source = 'database:live:economy_facts';
    const parsed = economyFactParamsSchema.safeParse(params);
    if (!parsed.success) return this.invalidParams(ctx, source, parsed.error);
    const { playerUuid, factType } = parsed.data;

    let query;
    try {
      query = await this.runTemplate('economyFact', [playerUuid, factType], ctx);
    } catch (error) {
      return this.failFromDbError(ctx, source, this.meta.maxVisibility, error);
    }

    if (query.rows.length > 1) return this.ambiguousRows(ctx, source, query.rows.length);
    const firstRow = query.rows[0];
    let result: EconomyFactResult;
    if (firstRow === undefined) {
      result = { found: false, playerUuid, factType };
    } else {
      const row = economyFactRowSchema.safeParse(firstRow);
      if (!row.success) return this.rowShapeError(ctx, source, row.error);
      result = {
        found: true,
        playerUuid,
        factType,
        value: String(row.data.fact_value),
        observedAt: String(row.data.observed_at),
      };
    }

    const isSubject =
      ctx.actor.id === playerUuid || ctx.actor.linkedUuid === playerUuid;
    if (
      !canDisclose(Visibility.PLAYER_SELF, ctx.visibilityCeiling, {
        isSubject,
        isStaff: isStaffLike(ctx.actor),
      })
    ) {
      return this.fail(ctx, {
        source,
        visibility: this.meta.maxVisibility,
        code: 'VISIBILITY_DENIED',
        message: 'economy fact is not disclosable to this actor',
        retryable: false,
      });
    }

    return this.ok<EconomyFactResult>(ctx, {
      source,
      visibility: Visibility.PLAYER_SELF,
      result,
      templateName: 'economyFact',
      rowCount: query.rows.length,
      truncated: query.truncated,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Toolset                                                           */
/* ------------------------------------------------------------------ */

/**
 * The five W10 database tools, ready to register into W12's ToolRegistry.
 * Each entry implements the Tool interface shape from tool-adapter.ts.
 */
export class DatabaseToolset {
  readonly tools: Tool[];
  private readonly byName: Map<string, Tool>;

  constructor(manager: DatabaseConnectionManager) {
    const runtime: ToolRuntime = { manager };
    this.tools = [
      new ResolveLinkedAccountTool(runtime),
      new GetPlayerRankTool(runtime),
      new GetPermissionStateTool(runtime),
      new GetTicketMetadataTool(runtime),
      new GetEconomyFactTool(runtime),
    ];
    this.byName = new Map(this.tools.map((tool) => [tool.meta.name, tool]));
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  get names(): string[] {
    return this.tools.map((tool) => tool.meta.name);
  }
}

/** Convenience factory. */
export function createDatabaseTools(
  manager: DatabaseConnectionManager,
): DatabaseToolset {
  return new DatabaseToolset(manager);
}

