import { loadConfig, redactedConfig } from './index.js';

/**
 * Config validation entrypoint for CI (§75 "configuration validation").
 *
 * Loads configuration from the environment, fails the process on invalid
 * values, and prints the redacted config (secrets are never printed).
 */
export function validateConfig(): void {
  const config = loadConfig();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(redactedConfig(config), null, 2));
}

// Allow `node dist/validate.js` to run validation directly after build.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    validateConfig();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Configuration validation failed:', error);
    process.exit(1);
  }
}
