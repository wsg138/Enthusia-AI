/**
 * @enthusia/integration-databases — template registry tests (W10).
 */
import { describe, expect, it } from 'vitest';
import {
  assertTemplateSafe,
  getQueryTemplate,
  listQueryTemplateNames,
  QueryTemplateError,
} from '../src/query-templates.js';
import type { QueryTemplate } from '../src/query-templates.js';

describe('query template registry', () => {
  it('registers exactly the five approved templates', () => {
    expect(listQueryTemplateNames()).toEqual([
      'linkedAccount',
      'playerRank',
      'permissionState',
      'ticketMetadata',
      'economyFact',
    ]);
  });

  it('every registered template passes the safety validator', () => {
    for (const name of listQueryTemplateNames()) {
      expect(() => assertTemplateSafe(getQueryTemplate(name))).not.toThrow();
    }
  });

  it('rejects unknown template names', () => {
    expect(() => getQueryTemplate('nope')).toThrowError(QueryTemplateError);
    expect(() => getQueryTemplate('nope')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_QUERY_TEMPLATE' }),
    );
    expect(() => getQueryTemplate('')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_QUERY_TEMPLATE' }),
    );
  });

  it('rejects non-SELECT statements', () => {
    const t: QueryTemplate = {
      name: 'linkedAccount',
      description: 'evil',
      sql: 'DELETE FROM account_links WHERE discord_id = ?',
      paramCount: 1,
    };
    expect(() => assertTemplateSafe(t)).toThrowError(
      expect.objectContaining({ code: 'TEMPLATE_VALIDATION_FAILED' }),
    );
  });

  it('rejects stacked statements', () => {
    const t: QueryTemplate = {
      name: 'linkedAccount',
      description: 'evil',
      sql: 'SELECT a FROM t WHERE x = ?; DELETE FROM t',
      paramCount: 1,
    };
    expect(() => assertTemplateSafe(t)).toThrowError(
      expect.objectContaining({ code: 'TEMPLATE_VALIDATION_FAILED' }),
    );
  });

  it('rejects SQL comments', () => {
    const t: QueryTemplate = {
      name: 'linkedAccount',
      description: 'evil',
      sql: 'SELECT a FROM t WHERE x = ? -- comment',
      paramCount: 1,
    };
    expect(() => assertTemplateSafe(t)).toThrowError(
      expect.objectContaining({ code: 'TEMPLATE_VALIDATION_FAILED' }),
    );
  });

  it('rejects string literals (every ? must be a true placeholder)', () => {
    const t: QueryTemplate = {
      name: 'linkedAccount',
      description: 'evil',
      sql: "SELECT a FROM t WHERE x = 'literal' AND y = ?",
      paramCount: 1,
    };
    expect(() => assertTemplateSafe(t)).toThrowError(
      expect.objectContaining({ code: 'TEMPLATE_VALIDATION_FAILED' }),
    );
  });

  it('rejects SELECT locking clauses', () => {
    const t: QueryTemplate = {
      name: 'linkedAccount',
      description: 'locking read',
      sql: 'SELECT a FROM t WHERE x = ? FOR UPDATE',
      paramCount: 1,
    };
    expect(() => assertTemplateSafe(t)).toThrowError(
      expect.objectContaining({ code: 'TEMPLATE_VALIDATION_FAILED' }),
    );
  });

  it('rejects placeholder count mismatches', () => {
    const t: QueryTemplate = {
      name: 'linkedAccount',
      description: 'evil',
      sql: 'SELECT a FROM t WHERE x = ? AND y = ?',
      paramCount: 1,
    };
    expect(() => assertTemplateSafe(t)).toThrowError(
      expect.objectContaining({ code: 'TEMPLATE_VALIDATION_FAILED' }),
    );
  });

  it('rejects write keywords hidden in identifiers', () => {
    const t: QueryTemplate = {
      name: 'linkedAccount',
      description: 'evil',
      sql: 'SELECT a INTO OUTFILE ? FROM t WHERE x = ?',
      paramCount: 2,
    };
    expect(() => assertTemplateSafe(t)).toThrowError(
      expect.objectContaining({ code: 'TEMPLATE_VALIDATION_FAILED' }),
    );
  });
});
