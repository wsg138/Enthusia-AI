/**
 * @enthusia/source-provenance — visibility assignment.
 *
 * Spec: MASTER-SPECIFICATION.md §17 (visibility and authorization model).
 *
 * The registry never guesses PUBLIC and never accepts SECRET_DENY:
 * - registration requires an explicit visibility, or an explicit opt-in to
 *   the conservative per-source-type default below;
 * - SECRET_DENY ("never indexed into model-visible storage", §17.6) is
 *   rejected at registration time — the store must not hold it at all.
 *
 * Defaults are deliberately conservative. Indexers that positively know a
 * source is public (e.g. the published rules document) pass an explicit
 * PUBLIC visibility instead of relying on the default.
 */

import { SourceType, Visibility } from '@enthusia/contracts';
import { SecretDenyRejectedError } from './errors.js';

/**
 * Conservative default visibility per source type, used only when the caller
 * explicitly opts in with `useDefaultVisibility`. The indexer/component that
 * understands the content should pass an explicit visibility instead.
 */
export const DEFAULT_VISIBILITY_BY_SOURCE_TYPE: Record<SourceType, Visibility> = {
  // Source code may be a private repo or contain internals; default staff.
  [SourceType.GITHUB]: Visibility.STAFF,
  // Live server files may contain configs/secrets; default staff.
  [SourceType.SFTP_FILE]: Visibility.STAFF,
  // Documents range from public rules to internal runbooks; default staff.
  [SourceType.DOCUMENT]: Visibility.STAFF,
  // Configs may embed secrets; default staff.
  [SourceType.CONFIG]: Visibility.STAFF,
  // Schema shape is internal reasoning material.
  [SourceType.DATABASE_SCHEMA]: Visibility.SYSTEM_INTERNAL,
  // Live rows may contain player data; default management.
  [SourceType.DATABASE_LIVE]: Visibility.MANAGEMENT,
  // Discord content is internal unless the indexer knows better.
  [SourceType.DISCORD]: Visibility.STAFF,
  // A ticket belongs to its reporter; player-self + staff (§17.2).
  [SourceType.TICKET]: Visibility.PLAYER_SELF,
  // Staff-authored operational knowledge is internal by default (§55).
  [SourceType.STAFF]: Visibility.STAFF,
  // Deployment metadata is internal operational information.
  [SourceType.DEPLOYMENT]: Visibility.STAFF,
  // Generated/intermediate artifacts are reasoning material, not disclosure.
  [SourceType.GENERATED]: Visibility.SYSTEM_INTERNAL,
};

export function defaultVisibilityForSourceType(sourceType: SourceType): Visibility {
  return DEFAULT_VISIBILITY_BY_SOURCE_TYPE[sourceType];
}

export interface AssignVisibilityOptions {
  sourceType: SourceType;
  /** Explicit visibility from the indexer/component. Always wins over the default. */
  explicit?: Visibility;
  /**
   * Opt in to the conservative default. Required when `explicit` is absent —
   * the registry never silently invents a visibility.
   */
  useDefault?: boolean;
}

/**
 * Resolve the visibility for a new artifact. Throws when neither an explicit
 * visibility nor an explicit default opt-in is provided, and throws
 * SecretDenyRejectedError for SECRET_DENY (§17.6).
 */
export function assignVisibility(options: AssignVisibilityOptions): Visibility {
  const { sourceType, explicit, useDefault } = options;
  if (explicit !== undefined) {
    if (explicit === Visibility.SECRET_DENY) {
      throw new SecretDenyRejectedError(`<${sourceType}>`);
    }
    return explicit;
  }
  if (useDefault === true) {
    return defaultVisibilityForSourceType(sourceType);
  }
  throw new Error(
    `visibility assignment for ${sourceType} requires an explicit visibility or useDefault: true`,
  );
}
