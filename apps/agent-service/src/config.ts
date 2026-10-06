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

const optionalText = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  });

export const agentServiceConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(4200),
  apiKeys: commaSeparatedKeys,
  maxBodyBytes: z.coerce.number().int().positive().default(65_536),
  sftpConfigPath: z.string().min(1).optional(),
  memoryDbPath: optionalText,
  ticketBotBaseUrl: optionalText,
  ticketBotApiKey: optionalText,
  ticketBotTimeoutMs: z.coerce.number().int().positive().max(30_000).default(10_000),
});

export type AgentServiceConfigFields = z.infer<typeof agentServiceConfigSchema>;

export interface AgentServiceConfig extends AgentServiceConfigFields {
  nodeEnv: AppConfig['nodeEnv'];
  serviceName: string;
  serviceVersion: string;
  logLevel: AppConfig['logLevel'];
}

function validateTicketBotPair(fields: AgentServiceConfigFields): void {
  const hasUrl = fields.ticketBotBaseUrl !== undefined;
  const hasKey = fields.ticketBotApiKey !== undefined;
  if (hasUrl !== hasKey) {
    throw new Error(
      'ENTHUSIA_AGENT_TICKET_BOT_BASE_URL and ENTHUSIA_AGENT_TICKET_BOT_API_KEY must be configured together.',
    );
  }
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
    memoryDbPath: env['ENTHUSIA_AGENT_MEMORY_DB_PATH'],
    ticketBotBaseUrl: env['ENTHUSIA_AGENT_TICKET_BOT_BASE_URL'],
    ticketBotApiKey: env['ENTHUSIA_AGENT_TICKET_BOT_API_KEY'],
    ticketBotTimeoutMs: env['ENTHUSIA_AGENT_TICKET_BOT_TIMEOUT_MS'],
  });
  validateTicketBotPair(fields);

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
    memoryConfigured: config.memoryDbPath !== undefined,
    ticketBotConfigured:
      config.ticketBotBaseUrl !== undefined && config.ticketBotApiKey !== undefined,
    ticketBotTimeoutMs: config.ticketBotTimeoutMs,
  };
}
