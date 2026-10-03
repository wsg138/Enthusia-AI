import { createLogger } from '@enthusia/logging';
import { loadConfig, redactedConfig } from '@enthusia/config';
import { loadGatewayConfig, redactedGatewayConfig } from './config.js';
import { MockAgent } from './agent.js';
import { AgentRegistry, Router } from './router.js';
import { GatewayRateLimiter } from './rate-limit.js';
import { startGateway } from './server.js';

/**
 * ai-gateway service entrypoint (`npm start` → node dist/main.js).
 *
 * Wires config → logger → router → mock agent → HTTP server, then serves
 * until SIGINT/SIGTERM. No model logic lives here (W03/W12).
 */
async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const logger = createLogger({
    name: config.serviceName,
    level: config.logLevel,
    base: { component: 'ai-gateway', version: config.serviceVersion },
  });

  if (config.apiKeys.length === 0) {
    logger.warn(
      'No ENTHUSIA_GATEWAY_API_KEYS configured — service authentication is DISABLED. ' +
        'Do not expose this instance beyond trusted networks.',
    );
  }

  const agents = new AgentRegistry();
  agents.register(new MockAgent());

  const gateway = await startGateway({
    config,
    logger,
    router: new Router(),
    agents,
    rateLimiter: new GatewayRateLimiter(config.rateLimitUserPerMin, config.rateLimitGlobalPerMin),
  });

  logger.info(
    { gateway: redactedGatewayConfig(config), base: redactedConfig(loadConfig()) },
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
  // A downstream dependency settling after its timeout must never take the
  // gateway down: log it and keep serving (withTimeout also guards each
  // call; this is the last-resort process guard).
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
}

void main().catch((err: unknown) => {
  // Last-resort: logger may not exist yet if config failed to load.
  // eslint-disable-next-line no-console
  console.error('ai-gateway failed to start:', err);
  process.exit(1);
});
