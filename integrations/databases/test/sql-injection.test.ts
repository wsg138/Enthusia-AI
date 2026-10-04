/**
 * @enthusia/integration-databases — SQL injection resistance tests (W10).
 *
 * The central guarantee: model-controlled input can only ever become a bound
 * parameter VALUE. It can never alter the SQL text, because the SQL text is
 * fixed at module load in the closed template registry and there is no API
 * anywhere in this package that accepts SQL text.
 */
import { describe, expect, it } from 'vitest';
import { makeHarness, staffContext, SAMPLE_UUID } from './helpers.js';
import { getQueryTemplate } from '../src/query-templates.js';
import * as dbPackage from '../src/index.js';

const HOSTILE_VALUES = [
  "' OR '1'='1",
  "' OR '1'='1' --",
  "1; DROP TABLE tickets; --",
  "' UNION SELECT password FROM users --",
  'enthusia.trade"; DROP TABLE player_ranks; --',
  '"; EXEC xp_cmdshell --',
  "' AND SLEEP(5) --",
  '\\"; SELECT * FROM account_links; --',
];

describe('injection attempts cannot alter executed SQL', () => {
  it.each(HOSTILE_VALUES)(
    'hostile value %p reaching the manager stays a bound param',
    async (hostile) => {
      // Bypass the tool-level zod allowlists on purpose: even if a hostile
      // scalar ever reached the manager, the SQL text must not change.
      const { manager, mock } = makeHarness();
      await manager.executeTemplate('permissionState', [SAMPLE_UUID, hostile]);
      expect(mock.calls).toHaveLength(1);
      const call = mock.calls[0]!;
      expect(call.sql).toBe(getQueryTemplate('permissionState').sql);
      expect(call.params[1]).toBe(hostile);
      expect(call.sql).not.toContain(hostile);
    },
  );

  it.each(HOSTILE_VALUES)(
    'hostile permissionNode %p is rejected or bound as a value',
    async (hostile) => {
      const { toolset, mock } = makeHarness();
      const tool = toolset.get('db.get_permission_state')!;
      const out = await tool.execute(
        { playerUuid: SAMPLE_UUID, permissionNode: hostile },
        staffContext(),
      );
      if (out.error !== undefined) {
        // Rejected at the zod boundary: never reached the driver.
        expect(out.error.code).toBe('INVALID_TOOL_PARAMS');
        expect(mock.calls).toHaveLength(0);
      } else {
        // Passed validation: the SQL text must still be byte-identical to
        // the registered template; the hostile string appears only in params.
        expect(mock.calls).toHaveLength(1);
        const call = mock.calls[0]!;
        expect(call.sql).toBe(getQueryTemplate('permissionState').sql);
        expect(call.params).toContain(hostile);
        expect(call.sql).not.toContain(hostile);
      }
    },
  );

  it('a hostile ticketId cannot stack statements', async () => {
    const { toolset, mock } = makeHarness();
    const out = await toolset
      .get('db.get_ticket_metadata')!
      .execute({ ticketId: 'T-1; DELETE FROM tickets' }, staffContext());
    expect(out.error?.code).toBe('INVALID_TOOL_PARAMS');
    expect(mock.calls).toHaveLength(0);
  });

  it('a hostile factType cannot invent an economy query', async () => {
    const { toolset, mock } = makeHarness();
    const out = await toolset
      .get('db.get_economy_fact')!
      .execute(
        {
          playerUuid: SAMPLE_UUID,
          factType: 'balance FROM economy_facts; --',
        },
        staffContext(),
      );
    expect(out.error?.code).toBe('INVALID_TOOL_PARAMS');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('no public API accepts SQL text', () => {
  it('exports no query/sql-executing function', () => {
    const names = Object.keys(dbPackage);
    for (const banned of [
      'query',
      'executeSql',
      'rawQuery',
      'runSql',
      'executeQuery',
    ]) {
      expect(
        names,
        `package must not export ${banned}`,
      ).not.toContain(banned);
    }
    // The template registry itself, and timeout tuning constants, are the only
    // legitimate places the words "query"/"sql" appear in export names.
    const suspicious = names.filter(
      (n) => /query|sql/i.test(n) && !/template|timeout/i.test(n),
    );
    expect(suspicious).toEqual([]);
  });

  it('the manager rejects unknown template names (no arbitrary statements)', async () => {
    const { manager } = makeHarness();
    await expect(
      manager.executeTemplate(
        'SELECT * FROM account_links' as never,
        [],
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_QUERY_TEMPLATE' });
    await expect(
      manager.executeTemplate('dropTables' as never, []),
    ).rejects.toMatchObject({ code: 'UNKNOWN_QUERY_TEMPLATE' });
  });

  it('the manager rejects non-scalar params (no driver object expansion)', async () => {
    const { manager } = makeHarness();
    await expect(
      manager.executeTemplate('linkedAccount', [{ $ne: null } as never]),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY_PARAMS' });
    await expect(
      manager.executeTemplate('linkedAccount', [['1', '2'] as never]),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY_PARAMS' });
    await expect(
      manager.executeTemplate('linkedAccount', []),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY_PARAMS' });
    await expect(
      manager.executeTemplate('permissionState', [SAMPLE_UUID]),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY_PARAMS' });
  });

  it('executed SQL is always byte-identical to the registered template', async () => {
    const { toolset, mock } = makeHarness();
    await toolset
      .get('db.get_player_rank')!
      .execute({ playerUuid: SAMPLE_UUID }, staffContext());
    await toolset
      .get('db.get_economy_fact')!
      .execute({ playerUuid: SAMPLE_UUID, factType: 'balance' }, staffContext());
    for (const call of mock.calls) {
      expect(call.sql).toBe(getQueryTemplate(call.template).sql);
    }
  });
});
