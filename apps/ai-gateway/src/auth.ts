import { timingSafeEqual } from 'node:crypto';
import {
  AuthorizationError,
  EnthusiaError,
  Visibility,
  visibilityRank,
  type ActorType,
  type ChatRequest,
  type EnthusiaErrorOptions,
} from '@enthusia/contracts';
import type { GatewayConfig } from './config.js';

/**
 * @enthusia/ai-gateway — request authentication and actor/surface validation.
 *
 * Spec: MASTER-SPECIFICATION.md §§17 (visibility), 34.3 (service
 * authentication), 34.4 (action authorization).
 *
 * Two layers:
 *  1. Service authentication — `Authorization: Bearer <key>` checked against
 *     the API keys from config. Required only when keys are configured.
 *  2. Actor/surface authorization — surface and actor type must be in the
 *     configured allowlists, and the requested visibility ceiling must not
 *     exceed the ceiling permitted for the actor type.
 */

/** Maximum visibility ceiling granted per actor type (§17 / §48.1). */
export const ACTOR_MAX_CEILING: Record<ActorType, Visibility> = {
  player: Visibility.PLAYER_SELF,
  staff: Visibility.STAFF,
  system: Visibility.SYSTEM_INTERNAL,
  unknown: Visibility.PUBLIC,
};

/** Build error options carrying a trace ID only when one is known. */
function traceOpts(traceId: string | undefined): EnthusiaErrorOptions {
  return traceId === undefined ? {} : { traceId };
}

/** Extract a Bearer token from an Authorization header value. */
export function extractBearerToken(authorization: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match?.[1];
}

/** Constant-time comparison against each configured key. */
function keyMatches(candidate: string, configuredKeys: string[]): boolean {
  const candidateBuf = Buffer.from(candidate, 'utf8');
  return configuredKeys.some((key) => {
    const keyBuf = Buffer.from(key, 'utf8');
    return candidateBuf.length === keyBuf.length && timingSafeEqual(candidateBuf, keyBuf);
  });
}

/**
 * Enforce service authentication.
 *
 * - When `config.apiKeys` is non-empty, a valid Bearer key is REQUIRED.
 * - When empty, authentication is disabled (dev/test) and this is a no-op.
 *
 * Throws EnthusiaError(401 AUTHENTICATION_FAILED) on missing/invalid keys.
 * The key value is never included in the error.
 */
export function authenticateServiceKey(
  headers: Record<string, string | string[] | undefined>,
  config: Pick<GatewayConfig, 'apiKeys'>,
  traceId?: string,
): void {
  if (config.apiKeys.length === 0) {
    return;
  }
  const token = extractBearerToken(headers['authorization']);
  if (token === undefined || !keyMatches(token, config.apiKeys)) {
    throw new EnthusiaError(
      'AUTHENTICATION_FAILED',
      401,
      'Missing or invalid service API key.',
      traceOpts(traceId),
    );
  }
}

/**
 * Validate surface and actor type against the configured allowlists.
 * Throws AuthorizationError (403) when either is not enabled.
 */
export function validateActorSurface(
  request: Pick<ChatRequest, 'surface' | 'actor'>,
  config: Pick<GatewayConfig, 'allowedSurfaces' | 'allowedActorTypes'>,
  traceId?: string,
): void {
  if (!config.allowedSurfaces.includes(request.surface)) {
    throw new AuthorizationError(
      `Surface '${request.surface}' is not enabled on this gateway.`,
      traceOpts(traceId),
    );
  }
  if (!config.allowedActorTypes.includes(request.actor.type)) {
    throw new AuthorizationError(
      `Actor type '${request.actor.type}' is not accepted by this gateway.`,
      traceOpts(traceId),
    );
  }
}

/**
 * Resolve the effective visibility ceiling for a request and enforce the
 * actor-type ceiling policy: the requested ceiling must not exceed the
 * maximum ceiling granted to the actor type.
 *
 * Returns the ceiling to propagate downstream (W02: identical to the
 * requested ceiling once validated; later workstreams may clamp per-role).
 * Throws AuthorizationError (403) when the ceiling exceeds the actor's grant.
 */
export function resolveVisibilityCeiling(
  actorType: ActorType,
  requested: Visibility,
  traceId?: string,
): Visibility {
  const max = ACTOR_MAX_CEILING[actorType];
  if (visibilityRank(requested) > visibilityRank(max)) {
    throw new AuthorizationError(
      `Visibility ceiling '${requested}' exceeds the maximum '${max}' granted to actor type '${actorType}'.`,
      traceOpts(traceId),
    );
  }
  return requested;
}
