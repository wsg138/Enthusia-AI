/**
 * Visibility and authorization model.
 *
 * Spec: MASTER-SPECIFICATION.md §17.
 *
 * Every knowledge item and tool result is assigned a visibility class.
 * Retrieval MUST enforce visibility before model-visible content is produced.
 */
export enum Visibility {
  /** Safe for any player. */
  PUBLIC = 'PUBLIC',
  /** May be shown only to the relevant player and authorized staff. */
  PLAYER_SELF = 'PLAYER_SELF',
  /** Internal operational information. */
  STAFF = 'STAFF',
  /** Higher sensitivity. */
  MANAGEMENT = 'MANAGEMENT',
  /** Useful for reasoning but not directly disclosed. */
  SYSTEM_INTERNAL = 'SYSTEM_INTERNAL',
  /** Never indexed into model-visible storage (tokens, keys, credentials). */
  SECRET_DENY = 'SECRET_DENY',
}

/**
 * Sensitivity ordering used for visibility-ceiling checks (§48.1).
 *
 * An item is disclosable under a ceiling when its rank is at or below the
 * ceiling's rank. NOTE: PLAYER_SELF additionally requires an identity check —
 * the requester must be the subject player or authorized staff. The numeric
 * ordering alone is not sufficient for PLAYER_SELF.
 */
const VISIBILITY_RANK: Record<Visibility, number> = {
  [Visibility.PUBLIC]: 0,
  [Visibility.PLAYER_SELF]: 1,
  [Visibility.STAFF]: 2,
  [Visibility.MANAGEMENT]: 3,
  [Visibility.SYSTEM_INTERNAL]: 4,
  [Visibility.SECRET_DENY]: 5,
};

export function visibilityRank(visibility: Visibility): number {
  return VISIBILITY_RANK[visibility];
}

/**
 * Returns true when an item with `itemVisibility` may be disclosed under a
 * `ceiling` for the given requester.
 *
 * - SECRET_DENY items are never disclosable, regardless of ceiling.
 * - PLAYER_SELF items additionally require `isSubject` (requester is the
 *   subject player) or `isStaff` (requester is authorized staff).
 */
export function canDisclose(
  itemVisibility: Visibility,
  ceiling: Visibility,
  opts: { isSubject?: boolean; isStaff?: boolean } = {},
): boolean {
  if (itemVisibility === Visibility.SECRET_DENY) {
    return false;
  }
  if (visibilityRank(itemVisibility) > visibilityRank(ceiling)) {
    return false;
  }
  if (itemVisibility === Visibility.PLAYER_SELF) {
    return opts.isSubject === true || opts.isStaff === true;
  }
  return true;
}
