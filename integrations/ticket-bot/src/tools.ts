/**
 * @enthusia/integration-ticket-bot — agent tools (W14).
 *
 * Spec: MASTER-SPECIFICATION.md §16 (tool system), §16.2 (tool result
 * provenance), §17 (visibility).
 *
 * These tools are the ONLY way agent reasoning touches tickets. Their
 * shape mirrors W12's `Tool` interface
 * (services/agent-core/src/tool.ts) — `meta` + `execute(params, ctx)` —
 * so they can register directly into W12's `ToolRegistry` once that
 * workstream lands. This module defines the interface structurally and
 * does NOT import W12's code (W12 is a sibling workstream, not a base).
 *
 * Available tools:
 *   - `ticket.get_context`      — read ticket context (adapter output)
 *   - `ticket.request_close`    — REQUEST the Ticket Bot close a ticket
 *   - `ticket.request_escalation` — REQUEST escalation
 *
 * All are privacy-sensitive (ticket contents are identity-scoped) and
 * capped at STAFF max visibility. The close/escalation tools submit
 * action REQUESTS; the Ticket Bot validates and executes them (§20.2).
 * There is deliberately no `ticket.close` / `ticket.mutate` tool.
 */

import {
  AuthorizationError,
  EnthusiaError,
  Visibility,
  VisibilityDeniedError,
  visibilityRank,
} from '@enthusia/contracts';
import type { Actor, ToolResult } from '@enthusia/contracts';
import { TicketBotClient } from './client.js';
import { ticketToAgentContext } from './context.js';
import type { AgentTicketContext } from './context.js';
import type { ActionRequestResult } from './types.js';

/** Parameter declaration — mirrors W12's ToolParameterProperty. */
export interface TicketToolParameterProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
}

export interface TicketToolParametersSchema {
  type: 'object';
  properties: Record<string, TicketToolParameterProperty>;
  required?: string[];
}

/** Static metadata — mirrors W12's ToolMetadata. */
export interface TicketToolMetadata {
  name: string;
  description: string;
  parameters: TicketToolParametersSchema;
  privacySensitive: boolean;
  maxVisibility: Visibility;
}

/** Per-call context — mirrors W12's ToolCallContext. */
export interface TicketToolCallContext {
  traceId: string;
  actor: Actor;
  visibilityCeiling: Visibility;
  signal?: AbortSignal;
}

/**
 * Tool interface — structurally identical to W12's `Tool<TParams>`.
 * Implementations return @enthusia/contracts `ToolResult` envelopes with
 * §16.2 provenance (tool name, timestamp, source, visibility,
 * correlation ID, freshness).
 */
export interface TicketTool<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly meta: TicketToolMetadata;
  execute(params: TParams, ctx: TicketToolCallContext): Promise<ToolResult<unknown>>;
}

const SOURCE = 'ticket-bot';
/** Tool results carry ticket content: identity-scoped (§17.2). */
const TOOL_VISIBILITY = Visibility.PLAYER_SELF;

function successEnvelope<T>(
  toolName: string,
  ctx: TicketToolCallContext,
  result: T,
  freshness?: string,
): ToolResult<T> {
  return {
    toolName,
    timestamp: new Date().toISOString(),
    source: SOURCE,
    visibility: TOOL_VISIBILITY,
    correlationId: ctx.traceId,
    ...(freshness !== undefined ? { freshness } : {}),
    result,
  };
}

function errorEnvelope(
  toolName: string,
  ctx: TicketToolCallContext,
  err: unknown,
): ToolResult<unknown> {
  const code =
    err instanceof EnthusiaError ? err.code : 'EXTERNAL_SERVICE_ERROR';
  // Retryable only for transient failures; never for validation/auth.
  const retryable =
    err instanceof EnthusiaError
      ? err.code === 'RATE_LIMITED' ||
        err.code === 'EXTERNAL_SERVICE_ERROR' ||
        err.code === 'TOOL_TIMEOUT'
      : true;
  const message =
    err instanceof Error ? err.message : 'Unknown ticket tool failure.';
  return {
    toolName,
    timestamp: new Date().toISOString(),
    source: SOURCE,
    visibility: TOOL_VISIBILITY,
    correlationId: ctx.traceId,
    error: { code, message, retryable },
  };
}

/**
 * Visibility gate (§17): ticket context is identity-scoped. The tool may
 * only produce it when the caller's ceiling discloses PLAYER_SELF data
 * (rank-based; subject/staff identity binding is the orchestrator's
 * privacy gate per §15.3 — this tool never downgrades classification).
 */
function checkVisibility(ctx: TicketToolCallContext): void {
  if (visibilityRank(TOOL_VISIBILITY) > visibilityRank(ctx.visibilityCeiling)) {
    throw new VisibilityDeniedError({ traceId: ctx.traceId });
  }
}

function checkTicketReadAuthorization(
  ctx: TicketToolCallContext,
  ownerId: string,
): void {
  if (ctx.actor.type === 'staff') return;
  const actorOwnsTicket =
    ctx.actor.type === 'player' &&
    (ctx.actor.id === ownerId || ctx.actor.linkedUuid === ownerId);
  if (!actorOwnsTicket) {
    throw new AuthorizationError(
      'Ticket context is available only to the ticket owner or authorized staff.',
      { traceId: ctx.traceId },
    );
  }
}

function checkStaffActionAuthorization(ctx: TicketToolCallContext): void {
  checkVisibility(ctx);
  if (ctx.actor.type !== 'staff') {
    throw new AuthorizationError(
      'Ticket lifecycle requests require an authorized staff actor.',
      { traceId: ctx.traceId },
    );
  }
}

function requireParam(
  params: Record<string, unknown>,
  name: string,
): string {
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new EnthusiaError(
      'VALIDATION_ERROR',
      400,
      `Missing or invalid required param: ${name}.`,
    );
  }
  return value;
}

/** `ticket.get_context` — read ticket context for agent reasoning. */
export class GetTicketContextTool
  implements TicketTool<{ ticketId: string; maxMessages?: number }>
{
  readonly meta: TicketToolMetadata = {
    name: 'ticket.get_context',
    description:
      'Fetch read-only ticket context (status, participants, transcript ' +
      'excerpt) from the Ticket Bot for agent reasoning. Never mutates state.',
    parameters: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Ticket id, e.g. "T-1234".' },
        maxMessages: {
          type: 'integer',
          description: 'Max transcript messages to include (default 20).',
        },
      },
      required: ['ticketId'],
    },
    privacySensitive: true,
    maxVisibility: Visibility.STAFF,
  };

  constructor(private readonly client: TicketBotClient) {}

  async execute(
    params: { ticketId: string; maxMessages?: number },
    ctx: TicketToolCallContext,
  ): Promise<ToolResult<unknown>> {
    try {
      checkVisibility(ctx);
      const ticketId = requireParam(params, 'ticketId');
      const bundle = await this.client.getTicketContext(
        ticketId,
        params.maxMessages !== undefined
          ? { maxMessages: params.maxMessages }
          : {},
      );
      checkTicketReadAuthorization(ctx, bundle.ticket.owner.id);
      const context: AgentTicketContext = ticketToAgentContext(bundle, {
        traceId: ctx.traceId,
      });
      return successEnvelope(
        this.meta.name,
        ctx,
        context,
        bundle.ticket.version,
      );
    } catch (err) {
      return errorEnvelope(this.meta.name, ctx, err);
    }
  }
}

/** `ticket.request_close` — REQUEST the Ticket Bot close a ticket. */
export class RequestTicketCloseTool
  implements TicketTool<{ ticketId: string; reason: string }>
{
  readonly meta: TicketToolMetadata = {
    name: 'ticket.request_close',
    description:
      'Request that the Ticket Bot close a ticket, with a justification. ' +
      'This is a REQUEST, not a close: the Ticket Bot validates permissions, ' +
      'state, confirmation, and transcript/archive rules before executing.',
    parameters: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Ticket id, e.g. "T-1234".' },
        reason: {
          type: 'string',
          description: 'Justification recorded in the audit log.',
        },
      },
      required: ['ticketId', 'reason'],
    },
    privacySensitive: true,
    maxVisibility: Visibility.STAFF,
  };

  constructor(private readonly client: TicketBotClient) {}

  async execute(
    params: { ticketId: string; reason: string },
    ctx: TicketToolCallContext,
  ): Promise<ToolResult<unknown>> {
    try {
      checkStaffActionAuthorization(ctx);
      const ticketId = requireParam(params, 'ticketId');
      const reason = requireParam(params, 'reason');
      const result: ActionRequestResult = await this.client.requestClose(
        ticketId,
        reason,
        ctx.traceId,
      );
      return successEnvelope(this.meta.name, ctx, result);
    } catch (err) {
      return errorEnvelope(this.meta.name, ctx, err);
    }
  }
}

/** `ticket.request_escalation` — REQUEST the Ticket Bot escalate a ticket. */
export class RequestTicketEscalationTool
  implements
    TicketTool<{ ticketId: string; reason: string; assigneeId?: string }>
{
  readonly meta: TicketToolMetadata = {
    name: 'ticket.request_escalation',
    description:
      'Request that the Ticket Bot escalate a ticket (optionally to a ' +
      'specific staff member), with a justification. This is a REQUEST: the ' +
      'Ticket Bot validates and executes it.',
    parameters: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Ticket id, e.g. "T-1234".' },
        reason: {
          type: 'string',
          description: 'Justification recorded in the audit log.',
        },
        assigneeId: {
          type: 'string',
          description: 'Staff id to escalate to (omit for the staff queue).',
        },
      },
      required: ['ticketId', 'reason'],
    },
    privacySensitive: true,
    maxVisibility: Visibility.STAFF,
  };

  constructor(private readonly client: TicketBotClient) {}

  async execute(
    params: { ticketId: string; reason: string; assigneeId?: string },
    ctx: TicketToolCallContext,
  ): Promise<ToolResult<unknown>> {
    try {
      checkStaffActionAuthorization(ctx);
      const ticketId = requireParam(params, 'ticketId');
      const reason = requireParam(params, 'reason');
      const options: { assigneeId?: string; correlationId?: string } = {
        correlationId: ctx.traceId,
      };
      if (params.assigneeId !== undefined) {
        options.assigneeId = params.assigneeId;
      }
      const result: ActionRequestResult = await this.client.requestEscalation(
        ticketId,
        reason,
        options,
      );
      return successEnvelope(this.meta.name, ctx, result);
    } catch (err) {
      return errorEnvelope(this.meta.name, ctx, err);
    }
  }
}

/**
 * Build the full W14 tool set for one configured client. Register the
 * returned tools into W12's `ToolRegistry` (registry.register(tool)) —
 * registration throws on duplicate names, so each tool name is unique.
 */
export function createTicketTools(client: TicketBotClient): TicketTool[] {
  return [
    new GetTicketContextTool(client),
    new RequestTicketCloseTool(client),
    new RequestTicketEscalationTool(client),
  ];
}
