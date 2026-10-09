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
import { PieCloakPublicDocsPilot } from './public-docs.js';
import { WarzonePublicDocsPilot } from './warzone-public-docs.js';
import { KnowledgeSearchTool } from './knowledge-search.js';
import { IndexedPublicDocsResolver } from './indexed-public-docs.js';
import { createStagingPublicWebTool } from './public-web-search.js';
import { loadConfiguredFamiliarityRuntime } from './familiarity.js';
import {
  createAgentRuntime,
  loadConfiguredModerationHistoryTools,
  loadConfiguredSftpRuntime,
  loadConfiguredTicketEvidenceReview,
  loadConfiguredTicketTools,
} from './runtime.js';
import { startAgentService } from './server.js';
import { StaleTicketDecisionService } from './stale-ticket.js';

async function main(): Promise<void> {
  const config = loadAgentServiceConfig();
  const inferenceConfig = loadInferenceConfig();
  const publicDocsOptIn = process.env['ENTHUSIA_TEST_PIECLOAK_PUBLIC_DOCS'] === '1';
  const indexedOptIn = process.env['ENTHUSIA_TEST_KNOWLEDGE_BRIDGE'] === '1';
  if (indexedOptIn && (config.nodeEnv !== 'development' || !publicDocsOptIn)) {
    throw new Error('Indexed public docs require the isolated development public-docs pilot');
  }
  const indexerEndpoint = process.env['ENTHUSIA_INDEXER_BASE_URL'];
  const indexerKey = process.env['ENTHUSIA_INDEXER_API_KEY'];
  if (indexedOptIn && (!indexerEndpoint || !indexerKey)) {
    throw new Error('Indexed public docs require a configured internal knowledge service');
  }
  if (!indexedOptIn && (indexerEndpoint || indexerKey)) {
    throw new Error('Unexpected knowledge-service credentials without staging opt-in');
  }
  if (publicDocsOptIn && config.nodeEnv !== 'development') {
    throw new Error('Public documentation pilot is restricted to development test runtimes.');
  }
  const publicDocs = publicDocsOptIn ? new PieCloakPublicDocsPilot() : undefined;
  const warzoneDocs = publicDocsOptIn ? new WarzonePublicDocsPilot() : undefined;
  // This bridge invokes the typed W12-compatible read tool directly. It is
  // not model-plannable until excerpt-level claim verification is reviewed.
  const indexedDocs = indexedOptIn && indexerEndpoint && indexerKey
    ? new IndexedPublicDocsResolver(new KnowledgeSearchTool({
      baseUrl: indexerEndpoint, apiKey: indexerKey,
    })) : undefined;
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
  // No third-party public search is available unless the owner explicitly
  // enables this DEVELOPMENT-ONLY flag and supplies a separate API key.
  // Search snippets are unverified discovery hints, not claim evidence.
  const publicWebSearch = createStagingPublicWebTool(process.env, config.nodeEnv);
  const staleTicketDecision = new StaleTicketDecisionService(inference);
  const familiarity = loadConfiguredFamiliarityRuntime(config.memoryPath);
  const sftp = await loadConfiguredSftpRuntime(config.sftpConfigPath);
  const ticketTools = loadConfiguredTicketTools({
    ...(config.ticketBotBaseUrl !== undefined
      ? { baseUrl: config.ticketBotBaseUrl }
      : {}),
    ...(config.ticketBotApiKey !== undefined
      ? { apiKey: config.ticketBotApiKey }
      : {}),
    timeoutMs: config.ticketBotTimeoutMs,
  });
  const moderationHistoryTools = loadConfiguredModerationHistoryTools({
    ...(config.staffModerationBaseUrl !== undefined
      ? { staffModerationBaseUrl: config.staffModerationBaseUrl }
      : {}),
    ...(config.staffModerationApiKey !== undefined
      ? { staffModerationApiKey: config.staffModerationApiKey }
      : {}),
    staffModerationTimeoutMs: config.staffModerationTimeoutMs,
    ...(config.aiModerationBaseUrl !== undefined
      ? { aiModerationBaseUrl: config.aiModerationBaseUrl }
      : {}),
    ...(config.aiModerationClientId !== undefined
      ? { aiModerationClientId: config.aiModerationClientId }
      : {}),
    ...(config.aiModerationApiKey !== undefined
      ? { aiModerationApiKey: config.aiModerationApiKey }
      : {}),
    aiModerationTimeoutMs: config.aiModerationTimeoutMs,
  });
  const ticketEvidenceReview = loadConfiguredTicketEvidenceReview(
    {
      ...(config.ticketBotBaseUrl !== undefined
        ? { ticketBotBaseUrl: config.ticketBotBaseUrl }
        : {}),
      ...(config.ticketBotApiKey !== undefined
        ? { ticketBotApiKey: config.ticketBotApiKey }
        : {}),
      ticketBotTimeoutMs: config.ticketBotTimeoutMs,
      ...(config.staffModerationBaseUrl !== undefined
        ? { staffModerationBaseUrl: config.staffModerationBaseUrl }
        : {}),
      ...(config.staffModerationApiKey !== undefined
        ? { staffModerationApiKey: config.staffModerationApiKey }
        : {}),
      staffModerationTimeoutMs: config.staffModerationTimeoutMs,
      ...(config.policyServerId !== undefined
        ? { policyServerId: config.policyServerId }
        : {}),
      ...(config.policySourceId !== undefined
        ? { policySourceId: config.policySourceId }
        : {}),
    },
    sftp.gateway,
    inference,
  );

  const runtime = createAgentRuntime(
    reasoner,
    [
      ...sftp.tools,
      ...ticketTools,
      ...moderationHistoryTools,
      ...familiarity.tools,
      ...(publicWebSearch ? [publicWebSearch] : []),
    ],
    {
      ...(publicDocs !== undefined && warzoneDocs !== undefined ? {
        publicSourceResolver: async (request: import('@enthusia/agent-core').ResolvedChatRequest) =>
          (await indexedDocs?.resolve(request)) ??
          (await publicDocs.resolve(request)) ?? (await warzoneDocs.resolve(request)),
      } : {}),
      ...(familiarity.onVerifiedTopicHelp !== undefined
        ? { onVerifiedTopicHelp: familiarity.onVerifiedTopicHelp }
        : {}),
      onUnhandledError: (error, traceId) => {
        const message = error instanceof Error ? error.message : '';
        const knownModelPhase = /^(?:classifyIntent|planEvidence|nextStep): local reasoner returned (?:invalid JSON shape|non-JSON output)$/.test(message);
        logger.error({
          traceId,
          category: knownModelPhase ? message : 'unexpected_agent_failure',
        }, 'agent failed to complete request');
      },
    },
  );

  const service = await startAgentService({
    config,
    logger,
    orchestrator: runtime.orchestrator,
    registry: runtime.registry,
    inference,
    staleTicketDecision,
    ...(ticketEvidenceReview !== undefined
      ? { ticketEvidenceReview }
      : {}),
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
        familiarity.close();
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
