/**
 * @enthusia/player-identity — identity service (W11).
 *
 * Spec: MASTER-SPECIFICATION.md §68 (privacy-aware contextual reasoning),
 * §69 (player profile service), §17 (visibility).
 *
 * Two responsibilities:
 *
 * 1. Resolution — given a Discord ID / Minecraft UUID / username, return
 *    the normalized identity (UUID + current username + rank context).
 *    The linkage is PLAYER_SELF: only the subject player or authorized
 *    staff may see it.
 * 2. Relevance-based context — `getRelevantContext()` takes a purpose and
 *    returns ONLY the fields that purpose needs and that visibility allows.
 *    Unrelated private history is never fetched merely because it exists.
 */
import { canDisclose, Visibility } from '@enthusia/contracts';
import type {
  IdentityField,
  IdentityFieldValues,
  IdentityPurpose,
  IdentityRequester,
  PlayerIdentity,
  RelevantContext,
  WithheldField,
} from './types.js';
import {
  IDENTITY_FIELD_VISIBILITY,
  identityFieldValues,
  isIdentityPurpose,
  PURPOSE_FIELDS,
} from './types.js';
import type { IdentityStore } from './store.js';

/** Machine-readable service error codes. */
export type IdentityServiceErrorCode =
  | 'not_found'
  | 'visibility_denied'
  | 'not_authorized'
  | 'invalid_input';

export class IdentityServiceError extends Error {
  readonly code: IdentityServiceErrorCode;
  constructor(code: IdentityServiceErrorCode, message: string) {
    super(message);
    this.name = 'IdentityServiceError';
    this.code = code;
  }
}

/** The public-safe result of resolving one player's identity. */
export interface ResolvedIdentity {
  discordId: string;
  minecraftUuid: string;
  minecraftName: string;
  ranks: PlayerIdentity['ranks'];
  /** Visibility of this payload: always PLAYER_SELF (linkage included). */
  visibility: Visibility;
}

/**
 * Whether the requester is the subject of the identity record, i.e. the
 * PLAYER_SELF identity check (§17): the requester IS the player, or
 * authorized staff.
 */
export function isSubjectOrStaff(
  requester: IdentityRequester,
  identity: PlayerIdentity,
): { isSubject: boolean; isStaff: boolean } {
  const isSubject =
    (requester.discordId !== undefined && requester.discordId === identity.discordId) ||
    (requester.minecraftUuid !== undefined &&
      requester.minecraftUuid.toLowerCase() === identity.minecraftUuid);
  return { isSubject, isStaff: requester.isStaff };
}

export class PlayerIdentityService {
  constructor(private readonly store: IdentityStore) {}

  /**
   * Resolve by Discord ID → Minecraft UUID + current username + rank.
   * PLAYER_SELF: the requester must be the subject or staff, and the
   * visibility ceiling must admit PLAYER_SELF.
   */
  async resolveByDiscordId(
    discordId: string,
    requester: IdentityRequester,
    visibilityCeiling: Visibility = Visibility.PLAYER_SELF,
  ): Promise<ResolvedIdentity> {
    const identity = await this.store.findByDiscordId(discordId);
    if (identity === undefined) {
      throw new IdentityServiceError('not_found', 'no linked identity for discordId');
    }
    return this.toResolved(identity, requester, visibilityCeiling);
  }

  async resolveByUuid(
    minecraftUuid: string,
    requester: IdentityRequester,
    visibilityCeiling: Visibility = Visibility.PLAYER_SELF,
  ): Promise<ResolvedIdentity> {
    const identity = await this.store.findByUuid(minecraftUuid);
    if (identity === undefined) {
      throw new IdentityServiceError('not_found', 'no linked identity for minecraftUuid');
    }
    return this.toResolved(identity, requester, visibilityCeiling);
  }

  async resolveByUsername(
    username: string,
    requester: IdentityRequester,
    visibilityCeiling: Visibility = Visibility.PLAYER_SELF,
  ): Promise<ResolvedIdentity> {
    const identity = await this.store.findByUsername(username);
    if (identity === undefined) {
      throw new IdentityServiceError('not_found', 'no linked identity for username');
    }
    return this.toResolved(identity, requester, visibilityCeiling);
  }

  private async toResolved(
    identity: PlayerIdentity,
    requester: IdentityRequester,
    visibilityCeiling: Visibility,
  ): Promise<ResolvedIdentity> {
    const { isSubject, isStaff } = isSubjectOrStaff(requester, identity);
    if (!canDisclose(Visibility.PLAYER_SELF, visibilityCeiling, { isSubject, isStaff })) {
      throw new IdentityServiceError(
        'visibility_denied',
        'identity linkage is PLAYER_SELF: subject or staff only',
      );
    }
    const liveRanks = await this.store.getCurrentRanks(identity.minecraftUuid);
    return {
      discordId: identity.discordId,
      minecraftUuid: identity.minecraftUuid,
      minecraftName: identity.minecraftName,
      ranks: { ...liveRanks.ranks, groups: [...liveRanks.ranks.groups] },
      visibility: Visibility.PLAYER_SELF,
    };
  }

  /**
   * Relevance-based context (§68).
   *
   * Takes a purpose and returns only the fields that purpose needs and
   * that visibility allows. Private history (`nameHistory`, `bedrock`)
   * is included only when the purpose declares it relevant AND the
   * requester is authorized — it is never fetched by default.
   *
   * Fields the purpose wanted but visibility denied are reported in
   * `withheld` so callers can tell "not relevant" apart from
   * "relevant but not disclosable".
   */
  async getRelevantContext(
    identity: PlayerIdentity,
    purpose: IdentityPurpose,
    requester: IdentityRequester,
    visibilityCeiling: Visibility,
  ): Promise<RelevantContext> {
    if (!isIdentityPurpose(purpose)) {
      throw new IdentityServiceError('invalid_input', `unknown purpose: ${String(purpose)}`);
    }
    const { isSubject, isStaff } = isSubjectOrStaff(requester, identity);
    const values = identityFieldValues(identity);
    if (PURPOSE_FIELDS[purpose].includes('ranks')) {
      const liveRanks = await this.store.getCurrentRanks(identity.minecraftUuid);
      values.ranks = liveRanks.ranks;
    }
    const fields: Partial<IdentityFieldValues> = {};
    const withheld: WithheldField[] = [];

    for (const field of PURPOSE_FIELDS[purpose]) {
      const fieldVisibility = IDENTITY_FIELD_VISIBILITY[field];
      if (canDisclose(fieldVisibility, visibilityCeiling, { isSubject, isStaff })) {
        assignField(fields, field, values[field]);
      } else {
        withheld.push({ field, reason: withholdReason(fieldVisibility, isSubject, isStaff) });
      }
    }

    return {
      purpose,
      subject: { minecraftName: identity.minecraftName },
      fields,
      withheld,
    };
  }

  /**
   * Link a Discord ID to a Minecraft identity. Allowed for staff, or for
   * the subject linking their own account (self-service linking).
   */
  async linkIdentity(
    caller: IdentityRequester,
    discordId: string,
    minecraftUuid: string,
    minecraftName: string,
  ): Promise<ResolvedIdentity> {
    const selfLink =
      caller.discordId !== undefined && caller.discordId === discordId;
    if (!caller.isStaff && !selfLink) {
      throw new IdentityServiceError('not_authorized', 'linking requires staff or self');
    }
    const identity = await this.store.link(discordId, minecraftUuid, minecraftName);
    return this.toResolved(identity, caller, Visibility.PLAYER_SELF);
  }

  /** Staff-only: remove a linkage. */
  async unlinkIdentity(caller: IdentityRequester, discordId: string): Promise<boolean> {
    this.requireStaff(caller);
    return this.store.unlink(discordId);
  }

  /** Staff-only: record a username change (moves the old name to history). */
  async recordUsernameChange(
    caller: IdentityRequester,
    minecraftUuid: string,
    newName: string,
  ): Promise<void> {
    this.requireStaff(caller);
    await this.store.recordUsernameChange(minecraftUuid, newName);
  }

  /** Staff-only: update rank context. */
  async setRanks(
    caller: IdentityRequester,
    minecraftUuid: string,
    ranks: PlayerIdentity['ranks'],
  ): Promise<void> {
    this.requireStaff(caller);
    await this.store.setRanks(minecraftUuid, ranks);
  }

  private requireStaff(caller: IdentityRequester): void {
    if (!caller.isStaff) {
      throw new IdentityServiceError('not_authorized', 'staff only');
    }
  }
}

function assignField(
  fields: Partial<IdentityFieldValues>,
  field: IdentityField,
  value: IdentityFieldValues[IdentityField],
): void {
  switch (field) {
    case 'discordId':
      fields.discordId = value as string;
      break;
    case 'minecraftUuid':
      fields.minecraftUuid = value as string;
      break;
    case 'minecraftName':
      fields.minecraftName = value as string;
      break;
    case 'nameHistory':
      fields.nameHistory = value as IdentityFieldValues['nameHistory'];
      break;
    case 'bedrock':
      fields.bedrock = value as IdentityFieldValues['bedrock'];
      break;
    case 'ranks':
      fields.ranks = value as IdentityFieldValues['ranks'];
      break;
  }
}

function withholdReason(
  fieldVisibility: Visibility,
  isSubject: boolean,
  isStaff: boolean,
): string {
  if (fieldVisibility === Visibility.PLAYER_SELF && !isSubject && !isStaff) {
    return 'PLAYER_SELF: subject or staff only';
  }
  return 'above visibility ceiling';
}
