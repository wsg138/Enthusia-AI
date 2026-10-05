import { createLogger } from '@enthusia/logging';
import { loadConfig, redactedConfig } from '@enthusia/config';
import { loadGatewayConfig, redactedGatewayConfig } from './config.js';
import { MockAgent } from './agent.js';
import { HttpAgent } from './remote-agent.js';
import { AgentRegistry, Router } from './router.js';
import { GatewayRateLimiter } from './rate-limit.js';
import { startGateway } from './server.js';

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const logger = createLogger({
    name: config.serviceName,
    level: config.logLevel,
    base: { component: 'ai-gateway', version: config.serviceVersion },
  });

  if (config.apiKeys.length === 0) {
    logger.warn(
      'No ENTHUSIA_GATEWAY_API_KEYS configured — service authentication is disabled for development.',
    );
  }

  const agents = new AgentRegistry();
  let router: Router;
  if (config.agentBaseUrl !== undefined) {
    const remoteConfig: {
      baseUrl: string;
      apiKey?: string;
    } = { baseUrl: config.agentBaseUrl };
    if (config.agentApiKey !== undefined) {
      remoteConfig.apiKey = config.agentApiKey;
    }
    const remote = new HttpAgent(remoteConfig);
    agents.register(remote);
    router = new Router(remote.name);
  } else {
    const mock = new MockAgent();
    agents.register(mock);
    router = new Router(mock.name);
    logger.warn(
      'No ENTHUSIA_AGENT_BASE_URL configured — using mock downstream agent for development.',
    );
  }

  const gateway = await startGateway({
    config,
    logger,
    router,
    agents,
    rateLimiter: new GatewayRateLimiter(
      config.rateLimitUserPerMin,
      config.rateLimitGlobalPerMin,
    ),
  });

  logger.info(
    {
      gateway: redactedGatewayConfig(config),
      base: redactedConfig(loadConfig()),
      downstreamAgents: agents.names(),
    },
    `ai-gateway listening on port ${gateway.port}`,
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down ai-gateway');
    void gateway.close().then(
      () => {
        logger.info('ai-gateway stopped');
        process.exit(0);
      },
      (err: unknown) => {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('ai-gateway failed to start:', err);
  process.exit(1);
});
