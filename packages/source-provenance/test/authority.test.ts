import { describe, expect, it } from 'vitest';
import {
  AuthorityTier,
  authorityTier,
  compareAuthority,
  outranks,
  pickHighestAuthority,
} from '../src/authority.js';

describe('authorityTier', () => {
  it('ranks authorities per spec §30 (live > owner > deployment > git > staff > historical > generated)', () => {
    const order = [
      'live:permissions',
      'owner:lincoln',
      'deployment:smp',
      'github:wsg138/EnthusiaStaff',
      'staff:abc123',
      'something-brand-new',
      'historical:memory',
      'generated:summary',
    ];
    const tiers = order.map(authorityTier);
    for (let i = 0; i + 1 < tiers.length; i += 1) {
      expect(tiers[i]).toBeGreaterThan(tiers[i + 1] as AuthorityTier);
    }
  });

  it('maps known tiers exactly', () => {
    expect(authorityTier('live:permissions')).toBe(AuthorityTier.LIVE_SERVICE);
    expect(authorityTier('owner:policy')).toBe(AuthorityTier.OWNER);
    expect(authorityTier('deployment:smp')).toBe(AuthorityTier.DEPLOYMENT);
    expect(authorityTier('git:mirror')).toBe(AuthorityTier.GIT_DEPLOYED);
    expect(authorityTier('staff:xyz')).toBe(AuthorityTier.STAFF);
    expect(authorityTier('historical:note')).toBe(AuthorityTier.HISTORICAL);
    expect(authorityTier('indexer')).toBe(AuthorityTier.GENERATED);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(authorityTier('  GitHub:wsg138/X ')).toBe(AuthorityTier.GIT_DEPLOYED);
  });
});

describe('compareAuthority / outranks', () => {
  it('live technical sources outrank staff knowledge', () => {
    expect(compareAuthority('live:permissions', 'staff:abc')).toBeGreaterThan(0);
    expect(outranks('live:permissions', 'staff:abc')).toBe(true);
    expect(outranks('staff:abc', 'live:permissions')).toBe(false);
  });

  it('equal authorities tie', () => {
    expect(compareAuthority('github:a', 'github:b')).toBe(0);
  });
});

describe('pickHighestAuthority', () => {
  it('picks the single highest-authority item', () => {
    const items = [
      { id: 'staff-note', authority: 'staff:abc' },
      { id: 'git-file', authority: 'github:wsg138/X' },
      { id: 'live', authority: 'live:permissions' },
    ];
    const pick = pickHighestAuthority(items, (i) => i.authority);
    expect(pick.conflict).toBe(false);
    expect(pick.winner?.id).toBe('live');
  });

  it('reports a conflict on a tie at the top instead of picking silently', () => {
    const items = [
      { id: 'a', authority: 'github:x' },
      { id: 'b', authority: 'github:y' },
    ];
    const pick = pickHighestAuthority(items, (i) => i.authority);
    expect(pick.conflict).toBe(true);
    expect(pick.winner).toBeUndefined();
    expect(pick.top).toHaveLength(2);
  });

  it('handles an empty set', () => {
    const pick = pickHighestAuthority([], (_i: { authority: string }) => _i.authority);
    expect(pick.conflict).toBe(false);
    expect(pick.top).toHaveLength(0);
  });
});
