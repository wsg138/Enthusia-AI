import { startBotFromEnv } from './startup.js';

async function main(): Promise<void> {
  const started = await startBotFromEnv();
  // The process owns only the Discord gateway connection. The AI Gateway and
  // agent are independent services launched and supervised separately.
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.info(`Enthusia AI Discord adapter stopping (${signal})`);
    void started.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Discord adapter shutdown failed:', error);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  console.info('Enthusia AI Discord adapter ready');
}
void main().catch((error: unknown) => {
  console.error('Enthusia AI Discord adapter failed to start:', error);
  process.exitCode = 1;
});
