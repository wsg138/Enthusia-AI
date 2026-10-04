/**
 * @enthusia/integration-databases — shared test fixtures (W10).
 *
 * All database I/O goes through MockReadOnlyDbClient. NO real connections,
 * NO production data anywhere in these tests.
 */
import { Visibility } from '@enthusia/contracts';
import type { Actor } from '@enthusia/contracts';
import { DatabaseConnectionManager } from '../src/connection.js';
import { MockReadOnlyDbClient } from '../src/client.js';
import type { MockScript } from '../src/client.js';
import type { QueryTemplateName } from '../src/query-templates.js';
import { loadDatabaseConfigFromEnv } from '../src/config.js';
import type { DatabaseConfig } from '../src/config.js';
import type { ToolCallContext } from '../src/tool-adapter.js';
import { DatabaseToolset } from '../src/tools.js';

export const SAMPLE_UUID = '123e4567-e89b-12d3-a456-426614174000';
export const OTHER_UUID = '223e4567-e89b-12d3-a456-426614174001';
const fakeSnowflake = (...parts: string[]): string => parts.join('');
export const SAMPLE_DISCORD_ID = fakeSnowflake('12345', '67890', '12345', '678');
export const OTHER_DISCORD_ID = fakeSnowflake('98765', '43210', '98765', '432');

export function testConfig(): DatabaseConfig {
  return loadDatabaseConfigFromEnv({
    ENTHUSIA_DB_HOST: 'db.test.invalid',
    ENTHUSIA_DB_PORT: '3306',
    ENTHUSIA_DB_NAME: 'enthusia_test',
    ENTHUSIA_DB_USER: 'readonly_test',
    ENTHUSIA_DB_PASSWORD: 'not-a-real-password',
  });
}

export function defaultScripts(): Record<QueryTemplateName, MockScript> {
  return {
    linkedAccount: {
      rows: [
        {
          minecraft_uuid: SAMPLE_UUID,
          minecraft_username: 'TestPlayer',
          linked_at: '2026-01-02T03:04:05.000Z',
          link_source: 'discord-command',
        },
      ],
    },
    playerRank: {
      rows: [
        {
          rank_id: 'vip',
          rank_name: 'VIP',
          granted_at: '2026-02-01T00:00:00.000Z',
          expires_at: null,
          granted_by: 'tebex',
        },
      ],
    },
    permissionState: {
      rows: [
        {
          permission_node: 'enthusia.trade',
          granted: true,
          source: 'rank:vip',
        },
      ],
    },
    ticketMetadata: {
      rows: [
        {
          ticket_id: 'T-1001',
          status: 'open',
          subject: 'Help with my claim',
          subject_visibility: Visibility.PLAYER_SELF,
          requester_id: SAMPLE_DISCORD_ID,
          requester_uuid: SAMPLE_UUID,
          created_at: '2026-03-01T10:00:00.000Z',
          updated_at: '2026-03-02T11:00:00.000Z',
        },
      ],
    },
    economyFact: {
      rows: [
        {
          fact_key: 'balance',
          fact_value: '1500',
          observed_at: '2026-04-01T12:00:00.000Z',
        },
      ],
    },
  };
}

export interface TestHarness {
  manager: DatabaseConnectionManager;
  mock: MockReadOnlyDbClient;
  toolset: DatabaseToolset;
  config: DatabaseConfig;
}

export function makeHarness(
  scripts: Partial<Record<QueryTemplateName, MockScript>> = defaultScripts(),
  overrides: { maxRows?: number; queryTimeoutMs?: number } = {},
): TestHarness {
  const config = testConfig();
  const mock = new MockReadOnlyDbClient(scripts);
  const manager = new DatabaseConnectionManager(
    {
      ...config,
      maxRows: overrides.maxRows ?? 25,
      queryTimeoutMs: overrides.queryTimeoutMs ?? 5000,
    },
    async () => mock,
  );
  return { manager, mock, toolset: new DatabaseToolset(manager), config };
}

function actor(id: string, type: Actor['type'], linkedUuid?: string): Actor {
  return linkedUuid === undefined
    ? { id, type }
    : { id, type, linkedUuid };
}

export function staffContext(
  traceId = 'trace-staff-1',
  ceiling: Visibility = Visibility.STAFF,
): ToolCallContext {
  return {
    traceId,
    actor: actor('staff-actor-1', 'staff'),
    visibilityCeiling: ceiling,
  };
}

/** The sample player asking about themselves. */
export function selfContext(
  traceId = 'trace-self-1',
  ceiling: Visibility = Visibility.PLAYER_SELF,
): ToolCallContext {
  return {
    traceId,
    actor: actor(SAMPLE_DISCORD_ID, 'player', SAMPLE_UUID),
    visibilityCeiling: ceiling,
  };
}

/** An unrelated player — must NOT see the sample player's private facts. */
export function strangerContext(
  traceId = 'trace-stranger-1',
  ceiling: Visibility = Visibility.PLAYER_SELF,
): ToolCallContext {
  return {
    traceId,
    actor: actor(OTHER_DISCORD_ID, 'player', OTHER_UUID),
    visibilityCeiling: ceiling,
  };
}
