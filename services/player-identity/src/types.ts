/**
 * @enthusia/player-identity — identity model (W11).
 *
 * Spec: MASTER-SPECIFICATION.md §68 (privacy-aware contextual reasoning),
 * §69 (player profile service), §17 (visibility).
 *
 * The canonical identity bridge: one normalized record per player linking
 * Discord identity, Minecraft (Java) identity, optional Bedrock identity,
 * username history, and role/rank context.
 *
 * Visibility principle (spec §69 + W11 requirement): the identity LINKAGE
 * itself is PLAYER_SELF — visible to the player themselves and authorized
 * staff, never PUBLIC. Per-field visibility is declared in
 * {@link IDENTITY_FIELD_VISIBILITY}; the service enforces it with the
 * contracts `canDisclose` helper.
 */
import type { Visibility } from '@enthusia/contracts';
import { Visibility as V } from '@enthusia/contracts';

/** A previous Minecraft username with the date it stopped being current. */
export interface UsernameRecord {
  /** The username as it was at the time. */
  name: string;
  /** ISO 8601 timestamp when this name stopped being the current one. */
  changedAt: string;
}

/** Linked Bedrock (console/mobile) identity, when the player linked one. */
export interface BedrockIdentity {
  /** Bedrock gamertag. */
  gamerTag: string;
  /** Xbox user ID, when known. */
  xuid?: string;
  /** Floodgate UUID presented to the Java network, when known. */
  floodgateUuid?: string;
}

/** Role/rank context for the player on the network. */
export interface RankContext {
  /** Primary permission group (LuckPerms primary group). */
  primaryGroup: string;
  /** All permission groups, including inherited ones. */
  groups: string[];
  /** Donor rank, when the player holds one. */
  donorRank?: string;
  /** Staff role, when the player is staff. */
  staffRole?: 'Helper' | 'Mod' | 'Admin' | 'Founder';
}

/**
 * Normalized player identity — the canonical bridge record (§69).
 *
 * All fields here are MOCK-data shaped: the store backing is an in-memory
 * registry seeded with fictional players. No real Discord/Minecraft APIs
 * are consulted and no production data is stored.
 */
export interface PlayerIdentity {
  /** Discord user ID (snowflake). PLAYER_SELF. */
  discordId: string;
  /** Java Edition UUID (canonical, hyphenated). PLAYER_SELF. */
  minecraftUuid: string;
  /** Current Java username. PUBLIC (visible in chat/tab list anyway). */
  minecraftName: string;
  /** Previous usernames, oldest first. PLAYER_SELF — private history. */
  nameHistory: UsernameRecord[];
  /** Linked Bedrock identity, when the player linked one. PLAYER_SELF. */
  bedrock?: BedrockIdentity;
  /** Role/rank context. PLAYER_SELF — disclosed only when relevant. */
  ranks: RankContext;
  /** ISO 8601 timestamp of the last record refresh. */
  updatedAt: string;
}

/**
 * Individually addressable identity fields, used for purpose-based
 * context expansion (§68) and per-field visibility enforcement.
 */
export type IdentityField =
  | 'discordId'
  | 'minecraftUuid'
  | 'minecraftName'
  | 'nameHistory'
  | 'bedrock'
  | 'ranks';

export interface IdentityFieldValues {
  discordId: string;
  minecraftUuid: string;
  minecraftName: string;
  nameHistory: UsernameRecord[];
  bedrock: BedrockIdentity | undefined;
  ranks: RankContext;
}

/**
 * Per-field visibility (§17). The linkage (discordId ↔ minecraftUuid) and
 * everything derived from it is PLAYER_SELF: visible to the player
 * themselves and authorized staff, never PUBLIC. The current username is
 * PUBLIC because it is already visible in-game.
 */
export const IDENTITY_FIELD_VISIBILITY: Record<IdentityField, Visibility> = {
  discordId: V.PLAYER_SELF,
  minecraftUuid: V.PLAYER_SELF,
  minecraftName: V.PUBLIC,
  nameHistory: V.PLAYER_SELF,
  bedrock: V.PLAYER_SELF,
  ranks: V.PLAYER_SELF,
};

/**
 * Why identity context is being requested. Context access is
 * relevance-based (§68): each purpose declares exactly which fields it
 * needs, and the service never fetches unrelated private history.
 *
 * - `identity-linkage`: resolve the Discord ↔ Minecraft mapping itself.
 * - `rank-question`: "what rank am I?" — role/rank context relevant.
 * - `permission-check`: "why don't I have /fly?" — identity + rank.
 * - `ticket-support`: "what's my ticket history?" — identity linkage
 *   relevant if authorized; private history is NOT included by default.
 * - `moderation`: staff moderation context — full identity incl. history,
 *   staff-only.
 * - `server-info`: "what's the server IP?" — private history irrelevant.
 * - `general`: default — public information only.
 */
export type IdentityPurpose =
  | 'identity-linkage'
  | 'rank-question'
  | 'permission-check'
  | 'ticket-support'
  | 'moderation'
  | 'server-info'
  | 'general';

export const IDENTITY_PURPOSES: readonly IdentityPurpose[] = [
  'identity-linkage',
  'rank-question',
  'permission-check',
  'ticket-support',
  'moderation',
  'server-info',
  'general',
] as const;

/**
 * Purpose → relevant fields (§68 purpose-based context expansion).
 *
 * Private history (`nameHistory`, `bedrock`) is included ONLY for the
 * `moderation` purpose (staff-only) — every other purpose deliberately
 * excludes it, so unrelated private history is never fetched merely
 * because the service can.
 */
export const PURPOSE_FIELDS: Record<IdentityPurpose, readonly IdentityField[]> = {
  'identity-linkage': ['discordId', 'minecraftUuid', 'minecraftName'],
  'rank-question': ['minecraftName', 'ranks'],
  'permission-check': ['minecraftUuid', 'minecraftName', 'ranks'],
  'ticket-support': ['discordId', 'minecraftUuid', 'minecraftName'],
  moderation: ['discordId', 'minecraftUuid', 'minecraftName', 'nameHistory', 'bedrock', 'ranks'],
  'server-info': ['minecraftName'],
  general: ['minecraftName'],
};

/** Who is asking for identity context. */
export interface IdentityRequester {
  /** Discord user ID of the requester, when known. */
  discordId?: string;
  /** Minecraft UUID of the requester, when known. */
  minecraftUuid?: string;
  /** Whether the requester is authorized staff. */
  isStaff: boolean;
}

/** A purpose-relevant field that visibility enforcement withheld. */
export interface WithheldField {
  field: IdentityField;
  /** Human-readable, visibility-safe reason. */
  reason: string;
}

/**
 * Relevance-based identity context (§68).
 *
 * `fields` contains ONLY the purpose-relevant fields that passed visibility
 * enforcement. `withheld` documents every purpose-relevant field that was
 * denied and why, so callers can distinguish "not relevant" (absent from
 * both) from "relevant but not disclosable" (listed in `withheld`).
 */
export interface RelevantContext {
  purpose: IdentityPurpose;
  /** Public-safe subject descriptor, always present. */
  subject: { minecraftName: string };
  /** Disclosed purpose-relevant fields. */
  fields: Partial<IdentityFieldValues>;
  /** Purpose-relevant fields denied by visibility enforcement. */
  withheld: WithheldField[];
}

export function isIdentityPurpose(value: unknown): value is IdentityPurpose {
  return (
    typeof value === 'string' &&
    (IDENTITY_PURPOSES as readonly string[]).includes(value)
  );
}

export function identityFieldValues(identity: PlayerIdentity): IdentityFieldValues {
  return {
    discordId: identity.discordId,
    minecraftUuid: identity.minecraftUuid,
    minecraftName: identity.minecraftName,
    nameHistory: identity.nameHistory,
    bedrock: identity.bedrock,
    ranks: identity.ranks,
  };
}
