import { readFile } from 'node:fs/promises';
import {
  AgentOrchestrator,
  ToolRegistry,
  type OrchestratorDeps,
  type Reasoner,
  type Tool,
} from '@enthusia/agent-core';
import {
  TicketBotClient,
  TicketEvidenceClient,
  createTicketTools,
} from '@enthusia/integration-ticket-bot';
import {
  StaffModerationStateClient,
} from '@enthusia/integration-staff-moderation';
import { ModerationAdapter } from '@enthusia/moderation-adapter';
import { StaffModerationHistoryTool } from './moderation-history.js';
import type { InferenceClient } from '@enthusia/inference-adapter';
import {
  LivePolicyCatalogReader,
  TicketEvidenceReviewService,
} from './ticket-evidence-review.js';
import {
  LiveServerSourceGateway,
  compileConfig,
  createConfiguredSftpClientFactory,
  createLiveServerSourceTools,
  type RuntimeCredentialMaterial,
  type RuntimeCredentialRequest,
} from '@enthusia/integration-sftp';

export interface AgentRuntime {
  orchestrator: AgentOrchestrator;
  registry: ToolRegistry;
  registeredTools: string[];
}

export interface TicketBotRuntimeConfig {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
}

export type AgentRuntimeOptions = Pick<
  OrchestratorDeps,
  'onVerifiedTopicHelp' | 'onUnhandledError'
>;

export interface ModerationHistoryRuntimeConfig {
  staffModerationBaseUrl?: string;
  staffModerationApiKey?: string;
  staffModerationTimeoutMs: number;
  aiModerationBaseUrl?: string;
  aiModerationClientId?: string;
  aiModerationApiKey?: string;
  aiModerationTimeoutMs: number;
}

export function loadConfiguredModerationHistoryTools(
  config: ModerationHistoryRuntimeConfig,
): Tool[] {
  if (config.aiModerationBaseUrl === undefined) return [];
  if (
    config.aiModerationClientId === undefined ||
    config.aiModerationApiKey === undefined ||
    config.staffModerationBaseUrl === undefined ||
    config.staffModerationApiKey === undefined
  ) {
    throw new Error(
      'Moderation history runtime configuration is incomplete.',
    );
  }

  const staff = new StaffModerationStateClient({
    baseUrl: config.staffModerationBaseUrl,
    apiKey: config.staffModerationApiKey,
    timeoutMs: config.staffModerationTimeoutMs,
  });
  const moderation = new ModerationAdapter({
    client: {
      baseUrl: config.aiModerationBaseUrl,
      clientId: config.aiModerationClientId,
      apiKey: config.aiModerationApiKey,
      contextTimeoutMs: config.aiModerationTimeoutMs,
      healthTimeoutMs: config.aiModerationTimeoutMs,
    },
  });
  return [
    new StaffModerationHistoryTool({
      staff,
      moderation,
      enrichmentTimeoutMs: config.aiModerationTimeoutMs,
    }),
  ];
}

export interface TicketEvidenceReviewRuntimeConfig {
  ticketBotBaseUrl?: string;
  ticketBotApiKey?: string;
  ticketBotTimeoutMs: number;
  staffModerationBaseUrl?: string;
  staffModerationApiKey?: string;
  staffModerationTimeoutMs: number;
  policyServerId?: string;
  policySourceId?: string;
}

export function loadConfiguredTicketEvidenceReview(
  config: TicketEvidenceReviewRuntimeConfig,
  gateway: LiveServerSourceGateway | undefined,
  inference: Pick<InferenceClient, 'complete'>,
): TicketEvidenceReviewService | undefined {
  const policyConfigured =
    config.policyServerId !== undefined || config.policySourceId !== undefined;
  if (!policyConfigured) return undefined;
  if (
    config.staffModerationBaseUrl === undefined ||
    config.staffModerationApiKey === undefined ||
    config.ticketBotBaseUrl === undefined ||
    config.ticketBotApiKey === undefined ||
    config.policyServerId === undefined ||
    config.policySourceId === undefined ||
    gateway === undefined
  ) {
    throw new Error(
      'Ticket evidence review runtime configuration is incomplete.',
    );
  }

  const ticketConfig = {
    baseUrl: config.ticketBotBaseUrl,
    apiKey: config.ticketBotApiKey,
    timeoutMs: config.ticketBotTimeoutMs,
  };
  return new TicketEvidenceReviewService({
    ticketClient: new TicketBotClient(ticketConfig),
    evidenceClient: new TicketEvidenceClient(ticketConfig),
    policyReader: new LivePolicyCatalogReader({
      gateway,
      serverId: config.policyServerId,
      sourceId: config.policySourceId,
    }),
    moderationClient: new StaffModerationStateClient({
      baseUrl: config.staffModerationBaseUrl,
      apiKey: config.staffModerationApiKey,
      timeoutMs: config.staffModerationTimeoutMs,
    }),
    inference,
  });
}

export function createAgentRuntime(
  reasoner: Reasoner,
  tools: Tool[] = [],
  options: AgentRuntimeOptions = {},
): AgentRuntime {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return {
    orchestrator: new AgentOrchestrator({
      reasoner,
      registry,
      ...(options.onVerifiedTopicHelp !== undefined
        ? { onVerifiedTopicHelp: options.onVerifiedTopicHelp }
        : {}),
      ...(options.onUnhandledError !== undefined
        ? { onUnhandledError: options.onUnhandledError }
        : {}),
    }),
    registry,
    registeredTools: registry.list().map((tool) => tool.name),
  };
}

export function loadConfiguredTicketTools(
  config: TicketBotRuntimeConfig,
): Tool[] {
  if (config.baseUrl === undefined && config.apiKey === undefined) return [];
  if (config.baseUrl === undefined || config.apiKey === undefined) {
    throw new Error('Ticket Bot runtime configuration is incomplete.');
  }

  const client = new TicketBotClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });
  return createTicketTools(client) as Tool[];
}

function requireEnvCredentialSource(
  request: RuntimeCredentialRequest,
): void {
  if (request.authSource !== 'env') {
    throw new Error(
      'configured credential source is not supported by this runtime',
    );
  }
}

function credentialText(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readCredentialReference(
  request: RuntimeCredentialRequest,
  env: NodeJS.ProcessEnv,
): string {
  const raw = env[request.authRef];
  if (raw === undefined || raw.trim() === '') {
    throw new Error('configured SFTP credential reference is unavailable');
  }
  return raw;
}

function parseCredentialRecord(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('configured SFTP credential reference is invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('configured SFTP credential reference is invalid');
  }
  return value as Record<string, unknown>;
}

function credentialMaterial(
  record: Record<string, unknown>,
): RuntimeCredentialMaterial {
  const privateKey = credentialText(record, 'privateKey');
  const passphrase = credentialText(record, 'passphrase');
  const password = credentialText(record, 'password');

  if (privateKey === undefined && password === undefined) {
    throw new Error(
      'configured SFTP credential reference has no usable authentication material',
    );
  }

  return {
    ...(privateKey !== undefined ? { privateKey } : {}),
    ...(passphrase !== undefined ? { passphrase } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

function envCredential(
  request: RuntimeCredentialRequest,
  env: NodeJS.ProcessEnv,
): RuntimeCredentialMaterial {
  requireEnvCredentialSource(request);
  const raw = readCredentialReference(request, env);
  return credentialMaterial(parseCredentialRecord(raw));
}

export interface ConfiguredSftpRuntime {
  tools: Tool[];
  gateway?: LiveServerSourceGateway;
}

export async function loadConfiguredSftpRuntime(
  configPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfiguredSftpRuntime> {
  if (configPath === undefined) return { tools: [] };

  const raw = await readFile(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ENTHUSIA_AGENT_SFTP_CONFIG_PATH must point to valid JSON');
  }

  const compiled = compileConfig(parsed);
  const makeClient = createConfiguredSftpClientFactory(
    compiled,
    (request) => envCredential(request, env),
  );
  const gateway = new LiveServerSourceGateway(compiled, makeClient);
  const toolset = createLiveServerSourceTools(gateway);
  return {
    tools: toolset.tools as Tool[],
    gateway,
  };
}

export async function loadConfiguredSftpTools(
  configPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Tool[]> {
  return (await loadConfiguredSftpRuntime(configPath, env)).tools;
}
