import { loadConfig, type AppConfig } from '@enthusia/config';
import { z } from 'zod';

const commaSeparatedKeys = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined || value.trim() === ''
      ? []
      : value.split(',').map((part) => part.trim()).filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)));

export const agentServiceConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(4200),
  apiKeys: commaSeparatedKeys,
  maxBodyBytes: z.coerce.number().int().positive().default(65_536),
  sftpConfigPath: z.string().min(1).optional(),
});

export type AgentServiceConfigFields = z.infer<typeof agentServiceConfigSchema>;

export interface AgentServiceConfig extends AgentServiceConfigFields {
  nodeEnv: AppConfig['nodeEnv'];
  serviceName: string;
  serviceVersion: string;
  logLevel: AppConfig['logLevel'];
}

export function loadAgentServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentServiceConfig {
  const base = loadConfig(env);
  const fields = agentServiceConfigSchema.parse({
    port: env['ENTHUSIA_AGENT_PORT'],
    apiKeys: env['ENTHUSIA_AGENT_API_KEYS'],
    maxBodyBytes: env['ENTHUSIA_AGENT_MAX_BODY_BYTES'],
    sftpConfigPath: env['ENTHUSIA_AGENT_SFTP_CONFIG_PATH'],
  });

  if (base.nodeEnv === 'production' && fields.apiKeys.length === 0) {
    throw new Error(
      'ENTHUSIA_AGENT_API_KEYS must contain at least one service key when NODE_ENV=production.',
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

export function redactedAgentServiceConfig(
  config: AgentServiceConfig,
): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    logLevel: config.logLevel,
    port: config.port,
    apiKeysConfigured: config.apiKeys.length,
    authenticationEnabled: config.apiKeys.length > 0,
    maxBodyBytes: config.maxBodyBytes,
    sftpConfigured: config.sftpConfigPath !== undefined,
  };
}
