import { createLogger } from '@enthusia/logging';
import {
  InferenceClient,
  loadInferenceConfig,
  redactedInferenceConfig,
} from '@enthusia/inference-adapter';
import {
  loadAgentServiceConfig,
  redactedAgentServiceConfig,
} from './config.js';
import { InferenceReasoner } from './reasoner.js';
import {
  createAgentRuntime,
  loadConfiguredSftpTools,
  loadConfiguredTicketTools,
} from './runtime.js';
import { startAgentService } from './server.js';
import { StaleTicketDecisionService } from './stale-ticket.js';

async function main(): Promise<void> {
  const config = loadAgentServiceConfig();
  const inferenceConfig = loadInferenceConfig();
  const logger = createLogger({
    name: config.serviceName,
    level: config.logLevel,
    base: { component: 'agent-service', version: config.serviceVersion },
  });

  if (config.apiKeys.length === 0) {
    logger.warn(
      'No ENTHUSIA_AGENT_API_KEYS configured — internal service authentication is disabled for development.',
    );
  }

  const inference = new InferenceClient({
    config: inferenceConfig,
    logger,
  });
  const reasoner = new InferenceReasoner(inference);
  const staleTicketDecision = new StaleTicketDecisionService(inference);
  const sftpTools = await loadConfiguredSftpTools(config.sftpConfigPath);
  const ticketTools = loadConfiguredTicketTools({
    ...(config.ticketBotBaseUrl !== undefined
      ? { baseUrl: config.ticketBotBaseUrl }
      : {}),
    ...(config.ticketBotApiKey !== undefined
      ? { apiKey: config.ticketBotApiKey }
      : {}),
    timeoutMs: config.ticketBotTimeoutMs,
  });
  const runtime = createAgentRuntime(reasoner, [...sftpTools, ...ticketTools]);

  const service = await startAgentService({
    config,
    logger,
    orchestrator: runtime.orchestrator,
    registry: runtime.registry,
    inference,
    staleTicketDecision,
  });

  logger.info(
    {
      agent: redactedAgentServiceConfig(config),
      inference: redactedInferenceConfig(inferenceConfig),
      registeredTools: runtime.registeredTools,
    },
    'agent service started',
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down agent service');
    void service.close().then(
      () => {
        logger.info('agent service stopped');
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ error }, 'agent service shutdown failed');
        process.exit(1);
      },
    );
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });

  logger.info({ port: service.port }, 'agent service listening');
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('agent service failed to start:', error);
  process.exit(1);
});
