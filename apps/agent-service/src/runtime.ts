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

export interface TicketBotRuntime {
  tools: Tool[];
  client?: TicketBotClient;
  evidenceClient?: TicketEvidenceClient;
}

export interface SftpRuntime {
  tools: Tool[];
  gateway?: LiveServerSourceGateway;
}

export type AgentRuntimeOptions = Pick<
  OrchestratorDeps,
  'onVerifiedTopicHelp'
>;

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
    }),
    registry,
    registeredTools: registry.list().map((tool) => tool.name),
  };
}

export function loadConfiguredTicketRuntime(
  config: TicketBotRuntimeConfig,
): TicketBotRuntime {
  if (config.baseUrl === undefined && config.apiKey === undefined) {
    return { tools: [] };
  }
  if (config.baseUrl === undefined || config.apiKey === undefined) {
    throw new Error('Ticket Bot runtime configuration is incomplete.');
  }

  const common = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  };
  const client = new TicketBotClient(common);
  const evidenceClient = new TicketEvidenceClient(common);
  return {
    tools: createTicketTools(client) as Tool[],
    client,
    evidenceClient,
  };
}

export function loadConfiguredTicketTools(
  config: TicketBotRuntimeConfig,
): Tool[] {
  return loadConfiguredTicketRuntime(config).tools;
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

export async function loadConfiguredSftpRuntime(
  configPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SftpRuntime> {
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
