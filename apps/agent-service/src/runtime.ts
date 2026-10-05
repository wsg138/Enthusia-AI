import { readFile } from 'node:fs/promises';
import {
  AgentOrchestrator,
  ToolRegistry,
  type Reasoner,
  type Tool,
} from '@enthusia/agent-core';
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

export function createAgentRuntime(
  reasoner: Reasoner,
  tools: Tool[] = [],
): AgentRuntime {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return {
    orchestrator: new AgentOrchestrator({ reasoner, registry }),
    registry,
    registeredTools: registry.list().map((tool) => tool.name),
  };
}

function envCredential(
  request: RuntimeCredentialRequest,
  env: NodeJS.ProcessEnv,
): RuntimeCredentialMaterial {
  if (request.authSource !== 'env') {
    throw new Error('configured credential source is not supported by this runtime');
  }

  const raw = env[request.authRef];
  if (raw === undefined || raw.trim() === '') {
    throw new Error('configured SFTP credential reference is unavailable');
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('configured SFTP credential reference is invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('configured SFTP credential reference is invalid');
  }

  const record = value as Record<string, unknown>;
  const privateKey =
    typeof record['privateKey'] === 'string' && record['privateKey'].length > 0
      ? record['privateKey']
      : undefined;
  const passphrase =
    typeof record['passphrase'] === 'string' && record['passphrase'].length > 0
      ? record['passphrase']
      : undefined;
  const password =
    typeof record['password'] === 'string' && record['password'].length > 0
      ? record['password']
      : undefined;

  if (privateKey === undefined && password === undefined) {
    throw new Error('configured SFTP credential reference has no usable authentication material');
  }

  return {
    ...(privateKey !== undefined ? { privateKey } : {}),
    ...(passphrase !== undefined ? { passphrase } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

export async function loadConfiguredSftpTools(
  configPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Tool[]> {
  if (configPath === undefined) return [];

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

  return toolset.tools as Tool[];
}
