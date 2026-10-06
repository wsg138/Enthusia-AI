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

const optionalBoolean = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

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
  memoryPath: optionalText,
  ticketBotBaseUrl: optionalText,
  ticketBotApiKey: optionalText,
  ticketBotTimeoutMs: z.coerce.number().int().positive().max(30_000).default(10_000),
  ticketEvidenceEnabled: optionalBoolean,
  ticketWebhookSecret: optionalText,
  ticketEvidencePolicyServerId: optionalText,
  ticketEvidencePolicySourceId: optionalText,
  staffModerationBaseUrl: optionalText,
  staffModerationApiKey: optionalText,
  staffModerationTimeoutMs: z.coerce.number().int().positive().max(30_000).default(10_000),
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

function validateStaffModerationPair(
  fields: AgentServiceConfigFields,
): void {
  const hasUrl = fields.staffModerationBaseUrl !== undefined;
  const hasKey = fields.staffModerationApiKey !== undefined;
  if (hasUrl !== hasKey) {
    throw new Error(
      'ENTHUSIA_AGENT_STAFF_MODERATION_BASE_URL and ENTHUSIA_AGENT_STAFF_MODERATION_API_KEY must be configured together.',
    );
  }
}

function validateTicketEvidenceConfig(
  fields: AgentServiceConfigFields,
): void {
  if (!fields.ticketEvidenceEnabled) return;

  const missing: string[] = [];
  if (fields.sftpConfigPath === undefined) missing.push('ENTHUSIA_AGENT_SFTP_CONFIG_PATH');
  if (fields.ticketBotBaseUrl === undefined) missing.push('ENTHUSIA_AGENT_TICKET_BOT_BASE_URL');
  if (
    fields.ticketBotApiKey === undefined ||
    fields.ticketBotApiKey.length < 32
  ) {
    missing.push('ENTHUSIA_AGENT_TICKET_BOT_API_KEY (>=32 chars)');
  }
  if (fields.ticketWebhookSecret === undefined || fields.ticketWebhookSecret.length < 32) {
    missing.push('ENTHUSIA_AGENT_TICKET_WEBHOOK_SECRET (>=32 chars)');
  }
  if (fields.ticketEvidencePolicyServerId === undefined) {
    missing.push('ENTHUSIA_AGENT_TICKET_EVIDENCE_POLICY_SERVER_ID');
  }
  if (fields.ticketEvidencePolicySourceId === undefined) {
    missing.push('ENTHUSIA_AGENT_TICKET_EVIDENCE_POLICY_SOURCE_ID');
  }
  if (fields.staffModerationBaseUrl === undefined) {
    missing.push('ENTHUSIA_AGENT_STAFF_MODERATION_BASE_URL');
  }
  if (
    fields.staffModerationApiKey === undefined ||
    fields.staffModerationApiKey.length < 32
  ) {
    missing.push('ENTHUSIA_AGENT_STAFF_MODERATION_API_KEY (>=32 chars)');
  }
  if (missing.length > 0) {
    throw new Error(
      'Ticket evidence runtime is enabled but configuration is incomplete: ' +
        missing.join(', '),
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
    memoryPath: env['ENTHUSIA_AGENT_MEMORY_PATH'],
    ticketBotBaseUrl: env['ENTHUSIA_AGENT_TICKET_BOT_BASE_URL'],
    ticketBotApiKey: env['ENTHUSIA_AGENT_TICKET_BOT_API_KEY'],
    ticketBotTimeoutMs: env['ENTHUSIA_AGENT_TICKET_BOT_TIMEOUT_MS'],
    ticketEvidenceEnabled: env['ENTHUSIA_AGENT_TICKET_EVIDENCE_ENABLED'],
    ticketWebhookSecret: env['ENTHUSIA_AGENT_TICKET_WEBHOOK_SECRET'],
    ticketEvidencePolicyServerId: env['ENTHUSIA_AGENT_TICKET_EVIDENCE_POLICY_SERVER_ID'],
    ticketEvidencePolicySourceId: env['ENTHUSIA_AGENT_TICKET_EVIDENCE_POLICY_SOURCE_ID'],
    staffModerationBaseUrl: env['ENTHUSIA_AGENT_STAFF_MODERATION_BASE_URL'],
    staffModerationApiKey: env['ENTHUSIA_AGENT_STAFF_MODERATION_API_KEY'],
    staffModerationTimeoutMs: env['ENTHUSIA_AGENT_STAFF_MODERATION_TIMEOUT_MS'],
  });
  validateTicketBotPair(fields);
  validateStaffModerationPair(fields);
  validateTicketEvidenceConfig(fields);

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
    memoryConfigured: config.memoryPath !== undefined,
    ticketBotConfigured:
      config.ticketBotBaseUrl !== undefined && config.ticketBotApiKey !== undefined,
    ticketBotTimeoutMs: config.ticketBotTimeoutMs,
    ticketEvidenceEnabled: config.ticketEvidenceEnabled,
    ticketWebhookConfigured:
      config.ticketWebhookSecret !== undefined,
    ticketEvidencePolicyConfigured:
      config.ticketEvidencePolicyServerId !== undefined &&
      config.ticketEvidencePolicySourceId !== undefined,
    staffModerationConfigured:
      config.staffModerationBaseUrl !== undefined &&
      config.staffModerationApiKey !== undefined,
    staffModerationTimeoutMs: config.staffModerationTimeoutMs,
  };
}
