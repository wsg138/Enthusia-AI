/**
 * @enthusia/player-identity — orchestrator tools (W11).
 *
 * Spec: MASTER-SPECIFICATION.md §16 (tool system), §16.2 (tool result
 * provenance), §17 (visibility), §68 (relevance-based context).
 *
 * Exposes identity resolution and relevance-based context as typed tools
 * for the W12 agent orchestrator's ToolRegistry.
 *
 * NOTE — structural parity with W12: the `ToolMetadata`, `ToolCallContext`
 * and `Tool` shapes below are intentionally identical to W12's
 * `services/agent-core/src/tool.ts`. This package does NOT depend on
 * `@enthusia/agent-core` (W12 is a separate workstream; its code is not
 * modified), so the shapes are re-declared here. Structural typing means
 * these tool instances register directly into W12's `ToolRegistry` once
 * both workstreams are merged — no adapter needed.
 */
import type { Actor, ToolResult, Visibility } from '@enthusia/contracts';
import { SourceStatus, Visibility as V } from '@enthusia/contracts';
import type { IdentityPurpose } from './types.js';
import { IDENTITY_PURPOSES, isIdentityPurpose } from './types.js';
import type { IdentityRequester } from './types.js';
import type { IdentityStore } from './store.js';
import {
  IdentityServiceError,
  PlayerIdentityService,
} from './service.js';

/* ------------------------------------------------------------------ */
/* Structural copies of W12's tool.ts (see module docstring).          */
/* ------------------------------------------------------------------ */

export interface ToolParameterProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
}

export interface ToolParametersSchema {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolMetadata {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
  /** W12 verification tier; live identity/rank reads are Tier A. */
  verificationTier?: 'A' | 'B' | 'C';
  /** True when the tool can return private/identity-scoped data. */
  privacySensitive: boolean;
  /** Most sensitive visibility this tool may return (§17). */
  maxVisibility: Visibility;
}

export interface ToolCallContext {
  /** Request correlation ID, propagated end-to-end (§16.2). */
  traceId: string;
  actor: Actor;
  /** Caps the sensitivity of anything the tool may return (§17). */
  visibilityCeiling: Visibility;
  signal?: AbortSignal;
}

export interface Tool<TParams extends Record<string, unknown> = Record<string, unknown>> {
  readonly meta: ToolMetadata;
  execute(params: TParams, ctx: ToolCallContext): Promise<ToolResult<unknown>>;
}

/* ------------------------------------------------------------------ */
/* identity.resolve                                                    */
/* ------------------------------------------------------------------ */

export interface IdentityResolveParams extends Record<string, unknown> {
  discordId?: string;
  minecraftUuid?: string;
  username?: string;
}

/**
 * Resolve a Discord ID / Minecraft UUID / username to the normalized
 * identity: Minecraft UUID + current username + rank context.
 *
 * privacySensitive + maxVisibility PLAYER_SELF: the orchestrator's privacy
 * gate must refuse this tool unless the request legitimately needs
 * identity context (W12 §15.3 bounded curiosity), and the linkage is only
 * disclosed to the subject player or staff.
 */
export class IdentityResolveTool implements Tool<IdentityResolveParams> {
  readonly meta: ToolMetadata = {
    name: 'identity.resolve',
    description:
      'Resolve a Discord ID, Minecraft UUID, or username to the normalized ' +
      'player identity (Minecraft UUID, current username, rank context). ' +
      'Identity linkage is PLAYER_SELF: only the subject player or staff.',
    parameters: {
      type: 'object',
      properties: {
        discordId: { type: 'string', description: 'Discord user ID (snowflake).' },
        minecraftUuid: { type: 'string', description: 'Java Edition UUID.' },
        username: { type: 'string', description: 'Current or historical Minecraft username.' },
      },
    },
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: V.PLAYER_SELF,
  };

  private readonly service: PlayerIdentityService;

  constructor(store: IdentityStore) {
    this.service = new PlayerIdentityService(store);
  }

  async execute(params: IdentityResolveParams, ctx: ToolCallContext): Promise<ToolResult<unknown>> {
    const timestamp = new Date().toISOString();
    const requester = requesterFromActor(ctx.actor);
    try {
      const resolved = await this.resolve(params, requester, ctx.visibilityCeiling);
      return {
        toolName: this.meta.name,
        timestamp,
        source: 'player-identity',
        visibility: V.PLAYER_SELF,
        correlationId: ctx.traceId,
        freshness: liveFreshness(timestamp),
        result: resolved,
      };
    } catch (err) {
      return {
        toolName: this.meta.name,
        timestamp,
        source: 'player-identity',
        visibility: V.PLAYER_SELF,
        correlationId: ctx.traceId,
        error: toToolError(err),
      };
    }
  }

  private async resolve(
    params: IdentityResolveParams,
    requester: IdentityRequester,
    ceiling: Visibility,
  ): Promise<unknown> {
    const selector = identitySelector(params);
    switch (selector.kind) {
      case 'discordId':
        return this.service.resolveByDiscordId(selector.value, requester, ceiling);
      case 'minecraftUuid':
        return this.service.resolveByUuid(selector.value, requester, ceiling);
      case 'username':
        return this.service.resolveByUsername(selector.value, requester, ceiling);
    }
  }
}

/* ------------------------------------------------------------------ */
/* identity.context                                                    */
/* ------------------------------------------------------------------ */

export interface IdentityContextParams extends Record<string, unknown> {
  discordId?: string;
  minecraftUuid?: string;
  username?: string;
  purpose: IdentityPurpose;
}

/**
 * Relevance-based identity context (§68): given an identity and a purpose,
 * return ONLY the fields that purpose needs and that visibility allows.
 * Private history is never fetched by default.
 */
export class IdentityContextTool implements Tool<IdentityContextParams> {
  readonly meta: ToolMetadata = {
    name: 'identity.context',
    description:
      'Get purpose-relevant identity context for a player. Returns only the ' +
      'fields the purpose needs and visibility allows; unrelated private ' +
      'history is never included. Withheld fields are reported, not silent.',
    parameters: {
      type: 'object',
      properties: {
        discordId: { type: 'string', description: 'Discord user ID (snowflake).' },
        minecraftUuid: { type: 'string', description: 'Java Edition UUID.' },
        username: { type: 'string', description: 'Current or historical Minecraft username.' },
        purpose: {
          type: 'string',
          description: 'Why the context is needed (relevance-based access).',
          enum: [...IDENTITY_PURPOSES],
        },
      },
      required: ['purpose'],
    },
    verificationTier: 'A',
    privacySensitive: true,
    maxVisibility: V.PLAYER_SELF,
  };

  private readonly service: PlayerIdentityService;
  private readonly store: IdentityStore;

  constructor(store: IdentityStore) {
    this.store = store;
    this.service = new PlayerIdentityService(store);
  }

  async execute(params: IdentityContextParams, ctx: ToolCallContext): Promise<ToolResult<unknown>> {
    const timestamp = new Date().toISOString();
    const base = {
      toolName: this.meta.name,
      timestamp,
      source: 'player-identity',
      visibility: V.PLAYER_SELF as Visibility,
      correlationId: ctx.traceId,
    };
    try {
      const context = await this.context(params, requesterFromActor(ctx.actor), ctx.visibilityCeiling);
      return { ...base, freshness: liveFreshness(timestamp), result: context };
    } catch (err) {
      return { ...base, error: toToolError(err) };
    }
  }

  private async context(
    params: IdentityContextParams,
    requester: IdentityRequester,
    ceiling: Visibility,
  ): Promise<unknown> {
    if (!isIdentityPurpose(params.purpose)) {
      throw new IdentityServiceError('invalid_input', 'purpose is required and must be known');
    }
    const purpose: IdentityPurpose = params.purpose;
    const selector = identitySelector(params);
    let identity;
    switch (selector.kind) {
      case 'discordId':
        identity = await this.store.findByDiscordId(selector.value);
        break;
      case 'minecraftUuid':
        identity = await this.store.findByUuid(selector.value);
        break;
      case 'username':
        identity = await this.store.findByUsername(selector.value);
        break;
    }
    if (identity === undefined) {
      throw new IdentityServiceError('not_found', 'no linked identity');
    }
    return this.service.getRelevantContext(identity, purpose, requester, ceiling);
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

type IdentitySelector =
  | { kind: 'discordId'; value: string }
  | { kind: 'minecraftUuid'; value: string }
  | { kind: 'username'; value: string };

function identitySelector(
  params: Pick<IdentityResolveParams, 'discordId' | 'minecraftUuid' | 'username'>,
): IdentitySelector {
  const selectors: IdentitySelector[] = [];
  if (typeof params.discordId === 'string') {
    selectors.push({ kind: 'discordId', value: params.discordId });
  }
  if (typeof params.minecraftUuid === 'string') {
    selectors.push({ kind: 'minecraftUuid', value: params.minecraftUuid });
  }
  if (typeof params.username === 'string') {
    selectors.push({ kind: 'username', value: params.username });
  }
  if (selectors.length !== 1) {
    throw new IdentityServiceError(
      'invalid_input',
      'exactly one of discordId, minecraftUuid, username is required',
    );
  }
  return selectors[0]!;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map a W12 tool-call actor to an identity requester. The subject check
 * succeeds when the actor's own ID (or linked UUID) matches the record —
 * so a player asking about themselves passes PLAYER_SELF.
 */
export function requesterFromActor(actor: Actor): IdentityRequester {
  const requester: IdentityRequester = { isStaff: actor.type === 'staff' };
  if (/^\d{1,20}$/.test(actor.id)) {
    requester.discordId = actor.id;
  }
  const uuid = actor.linkedUuid ?? (UUID_RE.test(actor.id) ? actor.id : undefined);
  if (uuid !== undefined) {
    requester.minecraftUuid = uuid;
  }
  return requester;
}

function liveFreshness(observedTime: string): string {
  return JSON.stringify({
    version: `live:${observedTime}`,
    observedTime,
    sourceStatus: SourceStatus.CURRENT,
  });
}

function toToolError(err: unknown): { code: string; message: string; retryable: boolean } {
  if (err instanceof IdentityServiceError) {
    return { code: err.code, message: err.message, retryable: false };
  }
  if (err instanceof Error && 'code' in err) {
    const code = String((err as { code: unknown }).code);
    if (code === 'ambiguous') {
      return { code: 'ambiguous_identity', message: 'identity lookup is ambiguous', retryable: false };
    }
    if (code === 'not_found' || code === 'invalid_input') {
      return { code, message: 'identity lookup failed', retryable: false };
    }
  }
  return { code: 'internal', message: 'identity lookup failed', retryable: false };
}
