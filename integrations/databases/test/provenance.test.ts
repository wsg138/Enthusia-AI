/**
 * @enthusia/integration-databases — provenance tests (W10).
 *
 * Spec: MASTER-SPECIFICATION.md §16.2. Every result carries tool name,
 * timestamp, source, visibility, request correlation ID, and freshness.
 */
import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import {
  makeHarness,
  selfContext,
  staffContext,
  SAMPLE_UUID,
  SAMPLE_DISCORD_ID,
} from './helpers.js';
import { decodeFreshness } from '../src/provenance.js';

const CALLS: Array<{
  tool: string;
  params: Record<string, unknown>;
  template: string;
  source: string;
}> = [
  {
    tool: 'db.resolve_linked_account',
    params: { discordId: SAMPLE_DISCORD_ID },
    template: 'linkedAccount',
    source: 'database:live:account_links',
  },
  {
    tool: 'db.get_player_rank',
    params: { playerUuid: SAMPLE_UUID },
    template: 'playerRank',
    source: 'database:live:player_ranks',
  },
  {
    tool: 'db.get_permission_state',
    params: { playerUuid: SAMPLE_UUID, permissionNode: 'enthusia.trade' },
    template: 'permissionState',
    source: 'database:live:effective_permissions',
  },
  {
    tool: 'db.get_ticket_metadata',
    params: { ticketId: 'T-1001' },
    template: 'ticketMetadata',
    source: 'database:live:tickets',
  },
  {
    tool: 'db.get_economy_fact',
    params: { playerUuid: SAMPLE_UUID, factType: 'balance' },
    template: 'economyFact',
    source: 'database:live:economy_facts',
  },
];

describe('tool result provenance (§16.2)', () => {
  it.each(CALLS)(
    '$tool carries complete provenance',
    async ({ tool, params, template, source }) => {
      const { toolset } = makeHarness();
      const traceId = `trace-prov-${tool}`;
      const ctx =
        tool === 'db.get_ticket_metadata'
          ? staffContext(traceId)
          : selfContext(traceId);
      const out = await toolset.get(tool)!.execute(params, ctx);

      expect(out.error).toBeUndefined();
      expect(out.toolName).toBe(tool);
      expect(out.source).toBe(source);
      // ISO 8601 timestamp, parseable.
      expect(Number.isNaN(Date.parse(out.timestamp))).toBe(false);
      // Visibility is always a real enum member, never undefined.
      expect(Object.values(Visibility)).toContain(out.visibility);
      // Correlation ID propagates the request trace ID.
      expect(out.correlationId).toBe(traceId);
      // Freshness decodes and names the template that produced the rows.
      expect(out.freshness).toBeDefined();
      const freshness = decodeFreshness(out.freshness!);
      expect(freshness.sourceStatus).toBe('CURRENT');
      expect(freshness.queryTemplate).toBe(template);
      expect(Number.isNaN(Date.parse(freshness.observedAt))).toBe(false);
    },
  );

  it('error envelopes carry provenance but no payload', async () => {
    const { toolset } = makeHarness();
    const traceId = 'trace-prov-error';
    const out = await toolset
      .get('db.get_player_rank')!
      .execute({ playerUuid: 'not-a-uuid' }, staffContext(traceId));
    expect(out.error).toMatchObject({
      code: 'INVALID_TOOL_PARAMS',
      retryable: false,
    });
    expect(out.result).toBeUndefined();
    expect(out.toolName).toBe('db.get_player_rank');
    expect(out.correlationId).toBe(traceId);
    expect(Number.isNaN(Date.parse(out.timestamp))).toBe(false);
  });
});
