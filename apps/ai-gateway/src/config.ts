import { z } from 'zod';
import { loadConfig, type AppConfig } from '@enthusia/config';
import { SURFACES, type ActorType, type Surface } from '@enthusia/contracts';

export const ACTOR_TYPES = ['player', 'staff', 'system', 'unknown'] as const;

function csvEnumList<T extends string>(
  envDefault: string,
  allowed: readonly T[],
  label: string,
) {
  return z
    .string()
    .default(envDefault)
    .transform((s, ctx) => {
      const parts = s
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p.length > 0);
      const bad = parts.filter(
        (p) => !(allowed as readonly string[]).includes(p),
      );
      if (bad.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `Unknown ${label}: ${bad.join(', ')}`,
        });
        return z.NEVER;
      }
      if (parts.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `At least one ${label} must be configured`,
        });
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
  port: z.coerce.number().int().min(1).max(65535).default(4100),
  apiKeys: commaSeparatedKeys,
  allowedSurfaces: csvEnumList<Surface>(
    'discord,minecraft,ticket,staff',
    SURFACES,
    'surface',
  ),
  allowedActorTypes: csvEnumList<ActorType>(
    'player,staff,system,unknown',
    ACTOR_TYPES,
    'actor type',
  ),
  rateLimitUserPerMin: z.coerce.number().int().positive().default(20),
  rateLimitGlobalPerMin: z.coerce.number().int().positive().default(200),
  maxMessageBytes: z.coerce.number().int().positive().default(8192),
  maxBodyBytes: z.coerce.number().int().positive().default(65536),
  agentTimeoutMs: z.coerce.number().int().positive().default(30_000),
  readyProbeTimeoutMs: z.coerce.number().int().positive().default(5000),
  agentBaseUrl: z.string().url().optional(),
  agentApiKey: z.string().min(1).optional(),
});

export type GatewayConfigFields = z.infer<typeof gatewayConfigSchema>;

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
  agentBaseUrl: 'ENTHUSIA_AGENT_BASE_URL',
  agentApiKey: 'ENTHUSIA_AGENT_API_KEY',
} as const;

function validateAgentLink(fields: GatewayConfigFields): void {
  if (fields.agentApiKey !== undefined && fields.agentBaseUrl === undefined) {
    throw new Error(
      'ENTHUSIA_AGENT_API_KEY requires ENTHUSIA_AGENT_BASE_URL.',
    );
  }
}

function validateProductionGateway(
  nodeEnv: AppConfig['nodeEnv'],
  fields: GatewayConfigFields,
): void {
  if (nodeEnv !== 'production') return;
  if (fields.apiKeys.length === 0) {
    throw new Error(
      'ENTHUSIA_GATEWAY_API_KEYS must contain at least one service key when NODE_ENV=production.',
    );
  }
  if (fields.agentBaseUrl === undefined || fields.agentApiKey === undefined) {
    throw new Error(
      'ENTHUSIA_AGENT_BASE_URL and ENTHUSIA_AGENT_API_KEY are required when NODE_ENV=production.',
    );
  }
}

function parseGatewayFields(
  env: NodeJS.ProcessEnv,
  base: AppConfig,
): GatewayConfigFields {
  return gatewayConfigSchema.parse({
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
    agentBaseUrl: env[GATEWAY_ENV_MAP.agentBaseUrl],
    agentApiKey: env[GATEWAY_ENV_MAP.agentApiKey],
  });
}

export function loadGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const base = loadConfig(env);
  const fields = parseGatewayFields(env, base);
  validateAgentLink(fields);
  validateProductionGateway(base.nodeEnv, fields);

  return {
    ...fields,
    nodeEnv: base.nodeEnv,
    serviceName: base.serviceName,
    serviceVersion: base.serviceVersion,
    logLevel: base.logLevel,
  };
}

export function redactedGatewayConfig(
  config: GatewayConfig,
): Record<string, unknown> {
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
    remoteAgentConfigured: config.agentBaseUrl !== undefined,
    agentApiKeyConfigured: config.agentApiKey !== undefined,
  };
}
