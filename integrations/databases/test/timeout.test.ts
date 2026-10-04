/**
 * @enthusia/integration-databases — timeout tests (W10).
 *
 * Every query runs under a wall-clock budget. Slow drivers are abandoned and
 * reported as retryable DB_TIMEOUT — the orchestrator can retry or escalate
 * instead of hanging the investigation loop.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultScripts,
  makeHarness,
  staffContext,
  SAMPLE_UUID,
  SAMPLE_DISCORD_ID,
} from './helpers.js';

describe('query timeouts', () => {
  it('reports DB_TIMEOUT (retryable) when the driver is too slow', async () => {
    const { toolset, mock } = makeHarness(
      { playerRank: { latencyMs: 500 } },
      { queryTimeoutMs: 50 },
    );
    const out = await toolset
      .get('db.get_player_rank')!
      .execute({ playerUuid: SAMPLE_UUID }, staffContext());
    expect(out.result).toBeUndefined();
    expect(out.error).toMatchObject({ code: 'DB_TIMEOUT', retryable: true });
    expect(mock.calls[0]?.options.signal?.aborted).toBe(true);
  });

  it('succeeds when the driver answers within budget', async () => {
    const playerRank = defaultScripts().playerRank;
    const { toolset } = makeHarness(
      { playerRank: { ...playerRank, latencyMs: 20 } },
      { queryTimeoutMs: 1000 },
    );
    const out = await toolset
      .get('db.get_player_rank')!
      .execute({ playerUuid: SAMPLE_UUID }, staffContext());
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({ found: true });
  });

  it('manager-level timeout aborts without leaking internals', async () => {
    const { manager } = makeHarness(
      { linkedAccount: { latencyMs: 500 } },
      { queryTimeoutMs: 50 },
    );
    await expect(
      manager.executeTemplate('linkedAccount', [SAMPLE_DISCORD_ID]),
    ).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
  });

  it('a caller abort signal surfaces as a non-retryable abort', async () => {
    const { manager } = makeHarness({ linkedAccount: { latencyMs: 500 } });
    const controller = new AbortController();
    const pending = manager.executeTemplate('linkedAccount', [SAMPLE_DISCORD_ID], {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'DB_ABORTED' });
  });
});
