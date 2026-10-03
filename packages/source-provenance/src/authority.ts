/**
 * @enthusia/source-provenance — authority levels.
 *
 * Spec: MASTER-SPECIFICATION.md §30 (source authority hierarchy) and §56
 * (owner authority).
 *
 * The contract's `authority` field is a free-form string identifying who/what
 * asserts an artifact (e.g. 'live:permissions', 'github:wsg138/EnthusiaStaff',
 * 'staff:<id>', 'indexer', 'owner:lincoln'). This module ranks those
 * authorities so conflicts between CURRENT artifacts can be resolved
 * deterministically.
 *
 * Authority order, highest first (§30, §56):
 *  1. live technical sources (live permission service, live lookups);
 *  2. owner decisions (owner policy/correction, still verified when a live
 *     technical source can check a factual claim — §56);
 *  3. deployed artifacts (deployed config, deployment metadata);
 *  4. Git/source confirmed deployed;
 *  5. staff knowledge;
 *  6. unknown/other asserted sources;
 *  7. historical memory;
 *  8. generated/model output.
 */

/** Ranked authority tiers, highest rank = most authoritative. */
export enum AuthorityTier {
  LIVE_SERVICE = 7,
  OWNER = 6,
  DEPLOYMENT = 5,
  GIT_DEPLOYED = 4,
  STAFF = 3,
  UNKNOWN = 2,
  HISTORICAL = 1,
  GENERATED = 0,
}

/** Prefixes (lower-cased) that map an authority string onto a tier. */
const AUTHORITY_PREFIX_TIERS: Array<{ prefixes: string[]; tier: AuthorityTier }> = [
  { prefixes: ['live:', 'live-'], tier: AuthorityTier.LIVE_SERVICE },
  { prefixes: ['owner:', 'owner-'], tier: AuthorityTier.OWNER },
  { prefixes: ['deployment:', 'deployment-', 'deploy:'], tier: AuthorityTier.DEPLOYMENT },
  { prefixes: ['github:', 'git:', 'source:'], tier: AuthorityTier.GIT_DEPLOYED },
  { prefixes: ['staff:', 'staff-'], tier: AuthorityTier.STAFF },
  { prefixes: ['historical:', 'history:', 'memory:'], tier: AuthorityTier.HISTORICAL },
  { prefixes: ['generated:', 'indexer', 'ai:', 'model:'], tier: AuthorityTier.GENERATED },
];

/**
 * Map an authority string to its tier. Unrecognized authorities rank as
 * UNKNOWN — above historical/generated, below staff — so that a genuinely
 * new asserted source is not silently treated as lowest-authority.
 */
export function authorityTier(authority: string): AuthorityTier {
  const normalized = authority.trim().toLowerCase();
  for (const { prefixes, tier } of AUTHORITY_PREFIX_TIERS) {
    if (prefixes.some((p) => normalized.startsWith(p))) return tier;
  }
  return AuthorityTier.UNKNOWN;
}

/**
 * Compare two authorities: positive when `a` outranks `b`, negative when
 * `b` outranks `a`, zero on a tie. Ties must be resolved as CONFLICTED
 * (no precedence rule resolves them safely — §30 / SourceStatus.CONFLICTED).
 */
export function compareAuthority(a: string, b: string): number {
  return authorityTier(a) - authorityTier(b);
}

/** True when `candidate` strictly outranks `baseline`. */
export function outranks(candidate: string, baseline: string): boolean {
  return compareAuthority(candidate, baseline) > 0;
}

export interface AuthoritativePick<T> {
  /** The winning item, or undefined when there is a tie at the top. */
  winner?: T;
  /** True when two or more items tie for highest authority. */
  conflict: boolean;
  /** The top-ranked items (length > 1 means unresolved conflict). */
  top: T[];
}

/**
 * Pick the highest-authority item from a set, given an accessor for each
 * item's authority string. A tie at the top is reported as a conflict
 * rather than silently picking one.
 */
export function pickHighestAuthority<T>(
  items: readonly T[],
  authorityOf: (item: T) => string,
): AuthoritativePick<T> {
  let best = -1;
  let top: T[] = [];
  for (const item of items) {
    const tier = authorityTier(authorityOf(item));
    if (tier > best) {
      best = tier;
      top = [item];
    } else if (tier === best) {
      top.push(item);
    }
  }
  const pick: AuthoritativePick<T> = { conflict: top.length > 1, top };
  const sole = top[0];
  if (top.length === 1 && sole !== undefined) {
    pick.winner = sole;
  }
  return pick;
}
