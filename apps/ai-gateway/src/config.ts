import { z } from 'zod';
import { loadConfig, type AppConfig } from '@enthusia/config';
import { SURFACES, type ActorType, type Surface } from '@enthusia/contracts';

/**
 * @enthusia/ai-gateway — gateway-specific configuration.
 *
 * Spec: MASTER-SPECIFICATION.md §§18.4 (rate limiting), 34.3 (service
 * authentication), 36 (health/observability); WORKER-EXECUTION-PLAN.md §5 (W02).
 *
 * All values come from environment variables with safe defaults. Service API
 * keys may be omitted only in development/test. Production fails closed at
 * startup when no gateway service key is configured.
 */

export const ACTOR_TYPES = ['player', 'staff', 'system', 'unknown'] as const;

/** Comma-separated env list validated against a fixed allowlist (fail fast). */
function csvEnumList<T extends string>(envDefault: string, allowed: readonly T[], label: string) {
  return z
    .string()
    .default(envDefault)
    .transform((s, ctx) => {
      const parts = s
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p.length > 0);
      const bad = parts.filter((p) => !(allowed as readonly string[]).includes(p));
      if (bad.length > 0) {
        ctx.addIssue({ code: 'custom', message: `Unknown ${label}: ${bad.join(', ')}` });
        return z.NEVER;
      }
      if (parts.length === 0) {
        ctx.addIssue({ code: 'custom', message: `At least one ${label} must be configured` });
        return z.NEVER;
      }
      return parts as T[];
    });
}

const commaSeparatedKeys = z
  .string()
  .optional()
  .transform((s) =>
    s === undefined || s.trim() === ''
      ? []
      : s.split(',').map((p) => p.trim()).filter((p) => p.length > 0),
  )
  .pipe(z.array(z.string().min(1)));

export const gatewayConfigSchema = z.object({
  /** TCP port the gateway listens on. */
  port: z.coerce.number().int().min(1).max(65535).default(4100),

  /** Service API keys accepted as `Authorization: Bearer <key>`. Empty = auth disabled (dev/test). */
  apiKeys: commaSeparatedKeys,

  /** Surfaces this gateway instance serves. */
  allowedSurfaces: csvEnumList<Surface>('discord,minecraft,ticket,staff', SURFACES, 'surface'),

  /** Actor types this gateway instance accepts. */
  allowedActorTypes: csvEnumList<ActorType>('player,staff,system,unknown', ACTOR_TYPES, 'actor type'),

  /** Sliding-window rate limit: requests per minute per (surface, actor id). */
  rateLimitUserPerMin: z.coerce.number().int().positive().default(20),
  /** Sliding-window rate limit: requests per minute globally. */
  rateLimitGlobalPerMin: z.coerce.number().int().positive().default(200),

  /** Maximum UTF-8 byte length of ChatRequest.message. */
  maxMessageBytes: z.coerce.number().int().positive().default(8192),
  /** Maximum total HTTP request body size in bytes (abuse guard). */
  maxBodyBytes: z.coerce.number().int().positive().default(65536),

  /** Downstream agent call timeout in milliseconds. */
  agentTimeoutMs: z.coerce.number().int().positive().default(30_000),
  /** /health/ready dependency probe timeout in milliseconds. */
  readyProbeTimeoutMs: z.coerce.number().int().positive().default(5000),
});

export type GatewayConfigFields = z.infer<typeof gatewayConfigSchema>;

/** Full gateway runtime config: shared app config + gateway fields. */
export interface GatewayConfig extends GatewayConfigFields {
  nodeEnv: AppConfig['nodeEnv'];
  serviceName: string;
  serviceVersion: string;
  logLevel: AppConfig['logLevel'];
}

const GATEWAY_ENV_MAP = {
  port: 'ENTHUSIA_AI_GATEWAY_PORT',
  apiKeys: 'ENTHUSIA_GATEWAY_API_KEYS',
  allowedSurfaces: 'ENTHUSIA_GATEWAY_ALLOWED_SURFACES',
  allowedActorTypes: 'ENTHUSIA_GATEWAY_ALLOWED_ACTOR_TYPES',
  rateLimitUserPerMin: 'ENTHUSIA_GATEWAY_RATE_LIMIT_USER_PER_MIN',
  rateLimitGlobalPerMin: 'ENTHUSIA_GATEWAY_RATE_LIMIT_GLOBAL_PER_MIN',
  maxMessageBytes: 'ENTHUSIA_GATEWAY_MAX_MESSAGE_BYTES',
  maxBodyBytes: 'ENTHUSIA_GATEWAY_MAX_BODY_BYTES',
  agentTimeoutMs: 'ENTHUSIA_GATEWAY_AGENT_TIMEOUT_MS',
  readyProbeTimeoutMs: 'ENTHUSIA_GATEWAY_READY_PROBE_TIMEOUT_MS',
} as const;

/** Load and validate the gateway configuration from `env`. */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const base = loadConfig(env);
  const fields = gatewayConfigSchema.parse({
    port: env[GATEWAY_ENV_MAP.port] ?? base.aiGatewayPort,
    apiKeys: env[GATEWAY_ENV_MAP.apiKeys],
    allowedSurfaces: env[GATEWAY_ENV_MAP.allowedSurfaces],
    allowedActorTypes: env[GATEWAY_ENV_MAP.allowedActorTypes],
    rateLimitUserPerMin: env[GATEWAY_ENV_MAP.rateLimitUserPerMin],
    rateLimitGlobalPerMin: env[GATEWAY_ENV_MAP.rateLimitGlobalPerMin],
    maxMessageBytes: env[GATEWAY_ENV_MAP.maxMessageBytes],
    maxBodyBytes: env[GATEWAY_ENV_MAP.maxBodyBytes],
    agentTimeoutMs: env[GATEWAY_ENV_MAP.agentTimeoutMs],
    readyProbeTimeoutMs: env[GATEWAY_ENV_MAP.readyProbeTimeoutMs],
  });

  if (base.nodeEnv === 'production' && fields.apiKeys.length === 0) {
    throw new Error(
      'ENTHUSIA_GATEWAY_API_KEYS must contain at least one service key when NODE_ENV=production.',
    );
  }

  return {
    ...fields,
    nodeEnv: base.nodeEnv,
    serviceName: base.serviceName,
    serviceVersion: base.serviceVersion,
    logLevel: base.logLevel,
  };
}

/**
 * Startup-safe view of the config: safe to log. API key VALUES are never
 * included — only the count of configured keys.
 */
export function redactedGatewayConfig(config: GatewayConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    logLevel: config.logLevel,
    port: config.port,
    apiKeysConfigured: config.apiKeys.length,
    authenticationEnabled: config.apiKeys.length > 0,
    allowedSurfaces: config.allowedSurfaces,
    allowedActorTypes: config.allowedActorTypes,
    rateLimitUserPerMin: config.rateLimitUserPerMin,
    rateLimitGlobalPerMin: config.rateLimitGlobalPerMin,
    maxMessageBytes: config.maxMessageBytes,
    maxBodyBytes: config.maxBodyBytes,
    agentTimeoutMs: config.agentTimeoutMs,
    readyProbeTimeoutMs: config.readyProbeTimeoutMs,
  };
}
