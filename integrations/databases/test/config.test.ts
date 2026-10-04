/**
 * @enthusia/integration-databases — config and credential-hygiene tests (W10).
 *
 * Spec §5.5 / §34.1: tools hold credentials; credentials never enter tool
 * output, logs, or error messages.
 */
import { describe, expect, it } from 'vitest';
import {
  DatabaseConfigError,
  describeConfigForLog,
  loadDatabaseConfigFromEnv,
} from '../src/config.js';
import { DatabaseConnectionManager } from '../src/connection.js';
import { defaultDbClientFactory } from '../src/client.js';
import { testConfig } from './helpers.js';
import type { DatabaseConfig } from '../src/config.js';

const BASE_ENV = {
  ENTHUSIA_DB_HOST: 'db.test.invalid',
  ENTHUSIA_DB_NAME: 'enthusia_test',
  ENTHUSIA_DB_USER: 'readonly_test',
  ENTHUSIA_DB_PASSWORD: 'not-a-real-password',
};

describe('database config', () => {
  it('loads from the environment with defaults', () => {
    const config = loadDatabaseConfigFromEnv({ ...BASE_ENV });
    expect(config).toMatchObject({
      host: 'db.test.invalid',
      port: 3306,
      database: 'enthusia_test',
      username: 'readonly_test',
      queryTimeoutMs: 5000,
      maxRows: 25,
      readOnly: true,
    });
    // Password is held in memory for the driver, and only there.
    expect(config.password).toBe('not-a-real-password');
  });

  it('rejects missing required fields', () => {
    expect(() => loadDatabaseConfigFromEnv({})).toThrowError(
      DatabaseConfigError,
    );
  });

  it('rejects out-of-range tuning values instead of clamping silently', () => {
    expect(() =>
      loadDatabaseConfigFromEnv({
        ...BASE_ENV,
        ENTHUSIA_DB_QUERY_TIMEOUT_MS: '5',
      }),
    ).toThrowError(/invalid database configuration/);
  });

  it('the log-safe view contains no password key at all', () => {
    const view = describeConfigForLog(testConfig());
    expect('password' in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain('not-a-real-password');
  });

  it('the manager refuses a non-read-only config', () => {
    const config = testConfig();
    const writable = { ...config, readOnly: false } as unknown as DatabaseConfig;
    expect(
      () => new DatabaseConnectionManager(writable, defaultDbClientFactory),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_DB_CONFIG' }));
  });

  it('the default client factory fails closed (no silent connections)', async () => {
    await expect(defaultDbClientFactory(testConfig())).rejects.toMatchObject({
      code: 'DB_DRIVER_NOT_CONFIGURED',
    });
  });
});
