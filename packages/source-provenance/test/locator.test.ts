import { describe, expect, it } from 'vitest';
import { SourceType } from '@enthusia/contracts';
import {
  assertLocatorMatchesType,
  buildLocator,
  parseLocator,
} from '../src/locator.js';
import { InvalidLocatorError } from '../src/errors.js';

describe('buildLocator', () => {
  it('builds canonical locators for every source type', () => {
    expect(buildLocator(SourceType.GITHUB, 'wsg138/EnthusiaStaff', 'config.yml')).toBe(
      'github:wsg138/EnthusiaStaff:config.yml',
    );
    expect(buildLocator(SourceType.SFTP_FILE, 'smp', '/plugins/EnthusiaStaff/config.yml')).toBe(
      'sftp:smp:/plugins/EnthusiaStaff/config.yml',
    );
    expect(buildLocator(SourceType.DOCUMENT, 'rules', 'server-rules')).toBe(
      'document:rules:server-rules',
    );
    expect(buildLocator(SourceType.CONFIG, 'hub', 'server.properties')).toBe(
      'config:hub:server.properties',
    );
    expect(buildLocator(SourceType.DATABASE_SCHEMA, 'enthusia', 'players')).toBe(
      'dbschema:enthusia:players',
    );
    expect(buildLocator(SourceType.DATABASE_LIVE, 'enthusia', 'v_player_balances', 'uuid-1')).toBe(
      'dblive:enthusia:v_player_balances:uuid-1',
    );
    expect(buildLocator(SourceType.DISCORD, 'guild-1', 'channel-2', 'msg-3')).toBe(
      'discord:guild-1:channel-2:msg-3',
    );
    expect(buildLocator(SourceType.TICKET, 'ticketbot', 'T-1042')).toBe('ticket:ticketbot:T-1042');
    expect(buildLocator(SourceType.STAFF, 'staff-9', 'note-7')).toBe('staff:staff-9:note-7');
    expect(buildLocator(SourceType.DEPLOYMENT, 'enthusia-staff', 'smp')).toBe(
      'deployment:enthusia-staff:smp',
    );
    expect(buildLocator(SourceType.GENERATED, 'knowledge-indexer', 'rules-summary')).toBe(
      'generated:knowledge-indexer:rules-summary',
    );
  });

  it('rejects empty parts and parts containing a colon', () => {
    expect(() => buildLocator(SourceType.GITHUB)).toThrow(InvalidLocatorError);
    expect(() => buildLocator(SourceType.GITHUB, '')).toThrow(InvalidLocatorError);
    expect(() => buildLocator(SourceType.GITHUB, 'a:b')).toThrow(InvalidLocatorError);
  });
});

describe('parseLocator', () => {
  it('round-trips buildLocator for every source type', () => {
    const cases: Array<[SourceType, string[]]> = [
      [SourceType.GITHUB, ['wsg138/EnthusiaStaff', 'config.yml']],
      [SourceType.SFTP_FILE, ['smp', '/plugins/x/config.yml']],
      [SourceType.DOCUMENT, ['rules', 'server-rules']],
      [SourceType.CONFIG, ['hub', 'server.properties']],
      [SourceType.DATABASE_SCHEMA, ['enthusia', 'players']],
      [SourceType.DATABASE_LIVE, ['enthusia', 'v_balances']],
      [SourceType.DISCORD, ['g1', 'c2']],
      [SourceType.TICKET, ['ticketbot', 'T-1']],
      [SourceType.STAFF, ['s1', 'n1']],
      [SourceType.DEPLOYMENT, ['plugin', 'smp']],
      [SourceType.GENERATED, ['comp', 'name']],
    ];
    for (const [type, parts] of cases) {
      const locator = buildLocator(type, ...parts);
      const parsed = parseLocator(locator);
      expect(parsed.sourceType).toBe(type);
      expect(parsed.identity).toBe(parts.join(':'));
      expect(parsed.locator).toBe(locator);
    }
  });

  it('rejects malformed locators', () => {
    expect(() => parseLocator('no-scheme-here')).toThrow(InvalidLocatorError);
    expect(() => parseLocator('bogus:x')).toThrow(InvalidLocatorError);
    expect(() => parseLocator('github:')).toThrow(InvalidLocatorError);
  });
});

describe('assertLocatorMatchesType', () => {
  it('accepts a locator whose scheme matches the source type', () => {
    const locator = buildLocator(SourceType.GITHUB, 'wsg138/EnthusiaStaff', 'x.yml');
    expect(assertLocatorMatchesType(locator, SourceType.GITHUB).sourceType).toBe(
      SourceType.GITHUB,
    );
  });

  it('rejects a locator whose scheme mismatches the source type', () => {
    const locator = buildLocator(SourceType.SFTP_FILE, 'smp', '/x.yml');
    expect(() => assertLocatorMatchesType(locator, SourceType.GITHUB)).toThrow(
      InvalidLocatorError,
    );
  });
});
