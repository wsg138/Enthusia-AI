/**
 * @enthusia/player-identity — identity linkage store (W11).
 *
 * Spec: MASTER-SPECIFICATION.md §69 (player profile service).
 *
 * The store is the data layer behind the canonical identity bridge: it
 * persists the Discord ID ↔ Minecraft UUID linkage plus username history,
 * Bedrock identity, and rank context.
 *
 * This implementation is in-memory and seeded with fictional mock data.
 * NO real Discord/Minecraft APIs are consulted and NO production data is
 * stored. A production backing (database via W10 tools) can implement the
 * same {@link IdentityStore} interface later.
 */
import type {
  BedrockIdentity,
  PlayerIdentity,
  RankContext,
} from './types.js';

/** Machine-readable store error codes. */
export type IdentityStoreErrorCode =
  | 'invalid_input'
  | 'already_linked'
  | 'not_found'
  | 'ambiguous';

export class IdentityStoreError extends Error {
  readonly code: IdentityStoreErrorCode;
  constructor(code: IdentityStoreErrorCode, message: string) {
    super(message);
    this.name = 'IdentityStoreError';
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCORD_ID_RE = /^\d{1,20}$/;
const USERNAME_RE = /^\w{3,16}$/;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isValidDiscordId(value: string): boolean {
  return DISCORD_ID_RE.test(value);
}

export function isValidUsername(value: string): boolean {
  return USERNAME_RE.test(value);
}

/** Data-layer contract for the identity linkage registry. */
export interface CurrentRankSnapshot {
  ranks: RankContext;
  observedAt: string;
  source: string;
}

export interface IdentityStore {
  findByDiscordId(discordId: string): Promise<PlayerIdentity | undefined>;
  findByUuid(uuid: string): Promise<PlayerIdentity | undefined>;
  /**
   * Matches the current username or historical usernames. Throws
   * `ambiguous` rather than silently picking when a reused name maps to
   * more than one canonical player.
   */
  findByUsername(name: string): Promise<PlayerIdentity | undefined>;
  /**
   * Read CURRENT rank/role state from the live authority. Production
   * implementations must not satisfy this from conversation memory or a
   * long-lived identity cache.
   */
  getCurrentRanks(minecraftUuid: string): Promise<CurrentRankSnapshot>;
  /** Insert or replace a full identity record (validated). */
  upsert(identity: PlayerIdentity): Promise<void>;
  /**
   * Create a new linkage. Throws `already_linked` when the Discord ID or
   * the UUID is already linked to a different identity.
   */
  link(discordId: string, minecraftUuid: string, minecraftName: string): Promise<PlayerIdentity>;
  /** Remove the linkage for a Discord ID. Returns false when not linked. */
  unlink(discordId: string): Promise<boolean>;
  /** Record a username change: current name moves into history. */
  recordUsernameChange(minecraftUuid: string, newName: string, changedAt?: string): Promise<void>;
  setRanks(minecraftUuid: string, ranks: RankContext): Promise<void>;
  setBedrockIdentity(
    minecraftUuid: string,
    bedrock: BedrockIdentity | undefined,
  ): Promise<void>;
  size(): Promise<number>;
}

function validateNew(identity: PlayerIdentity): void {
  if (!isValidDiscordId(identity.discordId)) {
    throw new IdentityStoreError('invalid_input', 'invalid discordId');
  }
  if (!isValidUuid(identity.minecraftUuid)) {
    throw new IdentityStoreError('invalid_input', 'invalid minecraftUuid');
  }
  if (!isValidUsername(identity.minecraftName)) {
    throw new IdentityStoreError('invalid_input', 'invalid minecraftName');
  }
  for (const record of identity.nameHistory) {
    if (!isValidUsername(record.name)) {
      throw new IdentityStoreError('invalid_input', 'invalid name in nameHistory');
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** In-memory {@link IdentityStore}. Mock backing — not production data. */
export class InMemoryIdentityStore implements IdentityStore {
  private readonly byDiscordId = new Map<string, PlayerIdentity>();
  private readonly byUuid = new Map<string, PlayerIdentity>();

  private static clone(identity: PlayerIdentity): PlayerIdentity {
    const copy: PlayerIdentity = {
      ...identity,
      nameHistory: identity.nameHistory.map((r) => ({ ...r })),
      ranks: { ...identity.ranks, groups: [...identity.ranks.groups] },
    };
    if (identity.bedrock !== undefined) {
      copy.bedrock = { ...identity.bedrock };
    }
    return copy;
  }

  async findByDiscordId(discordId: string): Promise<PlayerIdentity | undefined> {
    const found = this.byDiscordId.get(discordId);
    return found === undefined ? undefined : InMemoryIdentityStore.clone(found);
  }

  async findByUuid(uuid: string): Promise<PlayerIdentity | undefined> {
    const found = this.byUuid.get(uuid.toLowerCase());
    return found === undefined ? undefined : InMemoryIdentityStore.clone(found);
  }

  async findByUsername(name: string): Promise<PlayerIdentity | undefined> {
    const lowered = name.toLowerCase();
    const matches = [...this.byUuid.values()].filter(
      (identity) =>
        identity.minecraftName.toLowerCase() === lowered ||
        identity.nameHistory.some((r) => r.name.toLowerCase() === lowered),
    );
    if (matches.length > 1) {
      throw new IdentityStoreError('ambiguous', 'username maps to multiple canonical players');
    }
    const found = matches[0];
    return found === undefined ? undefined : InMemoryIdentityStore.clone(found);
  }

  async getCurrentRanks(minecraftUuid: string): Promise<CurrentRankSnapshot> {
    const existing = this.byUuid.get(minecraftUuid.toLowerCase());
    if (existing === undefined) {
      throw new IdentityStoreError('not_found', 'no identity for minecraftUuid');
    }
    return {
      ranks: { ...existing.ranks, groups: [...existing.ranks.groups] },
      observedAt: nowIso(),
      source: 'identity-store:live-ranks',
    };
  }

  async upsert(identity: PlayerIdentity): Promise<void> {
    validateNew(identity);
    const record: PlayerIdentity = {
      ...InMemoryIdentityStore.clone(identity),
      minecraftUuid: identity.minecraftUuid.toLowerCase(),
      updatedAt: nowIso(),
    };
    // Replacing a linkage: drop stale index entries for this UUID/discordId.
    const existing = this.byUuid.get(record.minecraftUuid);
    if (existing !== undefined && existing.discordId !== record.discordId) {
      this.byDiscordId.delete(existing.discordId);
    }
    const existingByDiscord = this.byDiscordId.get(record.discordId);
    if (existingByDiscord !== undefined && existingByDiscord.minecraftUuid !== record.minecraftUuid) {
      this.byUuid.delete(existingByDiscord.minecraftUuid);
    }
    this.byDiscordId.set(record.discordId, record);
    this.byUuid.set(record.minecraftUuid, record);
  }

  async link(
    discordId: string,
    minecraftUuid: string,
    minecraftName: string,
  ): Promise<PlayerIdentity> {
    const uuid = minecraftUuid.toLowerCase();
    if (!isValidDiscordId(discordId) || !isValidUuid(minecraftUuid) || !isValidUsername(minecraftName)) {
      throw new IdentityStoreError('invalid_input', 'invalid link parameters');
    }
    const byDiscord = this.byDiscordId.get(discordId);
    if (byDiscord !== undefined && byDiscord.minecraftUuid !== uuid) {
      throw new IdentityStoreError('already_linked', 'discordId already linked to a different UUID');
    }
    const byUuid = this.byUuid.get(uuid);
    if (byUuid !== undefined && byUuid.discordId !== discordId) {
      throw new IdentityStoreError('already_linked', 'minecraftUuid already linked to a different discordId');
    }
    if (byDiscord !== undefined) {
      return InMemoryIdentityStore.clone(byDiscord);
    }
    const identity: PlayerIdentity = {
      discordId,
      minecraftUuid: uuid,
      minecraftName,
      nameHistory: [],
      ranks: { primaryGroup: 'default', groups: ['default'] },
      updatedAt: nowIso(),
    };
    this.byDiscordId.set(discordId, identity);
    this.byUuid.set(uuid, identity);
    return InMemoryIdentityStore.clone(identity);
  }

  async unlink(discordId: string): Promise<boolean> {
    const existing = this.byDiscordId.get(discordId);
    if (existing === undefined) {
      return false;
    }
    this.byDiscordId.delete(discordId);
    this.byUuid.delete(existing.minecraftUuid);
    return true;
  }

  async recordUsernameChange(
    minecraftUuid: string,
    newName: string,
    changedAt?: string,
  ): Promise<void> {
    if (!isValidUsername(newName)) {
      throw new IdentityStoreError('invalid_input', 'invalid newName');
    }
    const existing = this.byUuid.get(minecraftUuid.toLowerCase());
    if (existing === undefined) {
      throw new IdentityStoreError('not_found', 'no identity for minecraftUuid');
    }
    if (existing.minecraftName.toLowerCase() === newName.toLowerCase()) {
      existing.minecraftName = newName;
      existing.updatedAt = nowIso();
      return;
    }
    existing.nameHistory.push({
      name: existing.minecraftName,
      changedAt: changedAt ?? nowIso(),
    });
    existing.minecraftName = newName;
    existing.updatedAt = nowIso();
  }

  async setRanks(minecraftUuid: string, ranks: RankContext): Promise<void> {
    const existing = this.byUuid.get(minecraftUuid.toLowerCase());
    if (existing === undefined) {
      throw new IdentityStoreError('not_found', 'no identity for minecraftUuid');
    }
    existing.ranks = { ...ranks, groups: [...ranks.groups] };
    existing.updatedAt = nowIso();
  }

  async setBedrockIdentity(
    minecraftUuid: string,
    bedrock: BedrockIdentity | undefined,
  ): Promise<void> {
    const existing = this.byUuid.get(minecraftUuid.toLowerCase());
    if (existing === undefined) {
      throw new IdentityStoreError('not_found', 'no identity for minecraftUuid');
    }
    if (bedrock === undefined) {
      delete existing.bedrock;
    } else {
      existing.bedrock = { ...bedrock };
    }
    existing.updatedAt = nowIso();
  }

  async size(): Promise<number> {
    return this.byUuid.size;
  }
}
