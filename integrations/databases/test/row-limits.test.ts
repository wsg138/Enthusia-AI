/**
 * @enthusia/integration-databases — row limit tests (W10).
 *
 * Full tables must never be dumped into results. The manager enforces maxRows;
 * the result carries a truncated flag so the orchestrator knows data was cut.
 */
import { describe, expect, it } from 'vitest';
import { makeHarness, staffContext, SAMPLE_UUID } from './helpers.js';
import { DatabaseConnectionManager } from '../src/connection.js';
import { loadDatabaseConfigFromEnv } from '../src/config.js';
import { decodeFreshness } from '../src/provenance.js';
import type { DatabaseFreshness } from '../src/provenance.js';

function manyRankRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    rank_id: `rank-${i}`,
    rank_name: `Rank ${i}`,
    granted_at: '2026-02-01T00:00:00.000Z',
    expires_at: null,
    granted_by: 'tebex',
  }));
}

describe('row limits', () => {
  it('truncates to maxRows and flags truncation in freshness', async () => {
    const { toolset, mock } = makeHarness(
      { playerRank: { rows: manyRankRows(50) } },
      { maxRows: 10 },
    );
    const out = await toolset
      .get('db.get_player_rank')!
      .execute({ playerUuid: SAMPLE_UUID }, staffContext());
    expect(out.error).toBeUndefined();
    expect(out.freshness).toBeDefined();
    const freshness = decodeFreshness(out.freshness!) as DatabaseFreshness;
    expect(freshness.truncated).toBe(true);
    expect(freshness.rowCount).toBe(10);
    // The driver was told the cap up front.
    expect(mock.calls[0]!.options.maxRows).toBe(10);
  });

  it('does not flag truncation when rows fit within the cap', async () => {
    const { toolset } = makeHarness(
      { playerRank: { rows: manyRankRows(3) } },
      { maxRows: 10 },
    );
    const out = await toolset
      .get('db.get_player_rank')!
      .execute({ playerUuid: SAMPLE_UUID }, staffContext());
    expect(out.error).toBeUndefined();
    const freshness = decodeFreshness(out.freshness!) as DatabaseFreshness;
    expect(freshness.truncated).toBe(false);
    expect(freshness.rowCount).toBe(3);
  });

  it('manager re-enforces the cap even if a driver ignored it', async () => {
    // A misbehaving driver factory that ignores QueryOptions.maxRows.
    const { manager, config } = makeHarness();
    const rogueManager = new DatabaseConnectionManager(config, async () => ({
      label: 'rogue',
      async query(sql: string, params: readonly unknown[]) {
        return {
          sql,
          params,
          rows: manyRankRows(100),
          truncated: false,
          durationMs: 1,
        };
      },
      async close() {},
    }));
    const executed = await rogueManager.executeTemplate(
      'playerRank',
      [SAMPLE_UUID],
      { maxRows: 7 },
    );
    expect(executed.rows).toHaveLength(7);
    expect(executed.truncated).toBe(true);
    await rogueManager.close();
    await manager.close();
  });

  it('config rejects maxRows above the hard ceiling', () => {
    expect(() =>
      loadDatabaseConfigFromEnv({
        ENTHUSIA_DB_HOST: 'h',
        ENTHUSIA_DB_NAME: 'd',
        ENTHUSIA_DB_USER: 'u',
        ENTHUSIA_DB_MAX_ROWS: '1000000',
      }),
    ).toThrowError(/invalid database configuration/);
  });
});
