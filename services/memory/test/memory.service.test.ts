/**
 * @enthusia/memory — acceptance tests (W05).
 *
 * Spec: MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §23 (mandatory automated tests)
 * and WORKER-EXECUTION-PLAN.md §8 acceptance: replace current, invalidate
 * current, conflict, history, current-only search, race/concurrency, evidence
 * preservation.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvidenceRole, SourceStatus, Visibility } from '@enthusia/contracts';
import {
  ConcurrentModificationError,
  CurrentRevisionExistsError,
  MemoryKeyNotFoundError,
  MemoryService,
  NoActiveRevisionError,
} from '../src/index.js';
import type { MemoryRef } from '../src/index.js';

const REF: MemoryRef = { namespace: 'command', key: 'trade.permission', scope: 'smp' };

function makeService() {
  return new MemoryService();
}

describe('W05 memory service — acceptance', () => {
  let svc: MemoryService;

  beforeEach(() => {
    svc = makeService();
  });

  afterEach(() => {
    svc.close();
  });

  it('replace current: A -> B supersession leaves ONLY B in current retrieval', async () => {
    const a = await svc.createRevision({
      ...REF,
      value: 'vip.trade',
      summary: 'trade permission = vip.trade',
      authority: 'indexer',
      evidence: [
        {
          sourceArtifactId: 'config:trade.yml',
          sourceVersion: 'abc',
          evidenceRole: EvidenceRole.PRIMARY,
        },
      ],
    });
    expect(a.revision.status).toBe(SourceStatus.CURRENT);

    // Creating a second CURRENT directly must fail — supersede is the only path.
    await expect(
      svc.createRevision({
        ...REF,
        value: 'x',
        summary: 'x',
        authority: 'indexer',
      }),
    ).rejects.toBeInstanceOf(CurrentRevisionExistsError);

    const { previous, current } = await svc.supersede({
      ...REF,
      value: 'enthusia.trade',
      summary: 'trade permission = enthusia.trade',
      authority: 'indexer',
      reason: 'config changed',
    });

    // Linkage both ways.
    expect(previous.id).toBe(a.revision.id);
    expect(previous.status).toBe(SourceStatus.SUPERSEDED);
    expect(previous.supersededByRevisionId).toBe(current.id);
    expect(current.supersedesRevisionId).toBe(previous.id);
    expect(current.status).toBe(SourceStatus.CURRENT);

    // Core invariant: current lookup returns ONLY B.
    const got = svc.getCurrent(REF);
    expect(got).not.toBeNull();
    expect(got!.revision.id).toBe(current.id);
    expect(got!.revision.value).toBe('enthusia.trade');
  });

  it('invalidate current: mark INVALID, verify gone from current retrieval', async () => {
    await svc.createRevision({
      ...REF,
      value: 'vip.trade',
      summary: 'trade permission = vip.trade',
      authority: 'indexer',
    });
    const invalid = await svc.invalidate({
      ...REF,
      reason: 'command removed from the server',
      authority: 'staff:lincoln',
    });
    expect(invalid.status).toBe(SourceStatus.INVALID);

    // Gone from normal current retrieval — and no replacement invented.
    expect(svc.getCurrent(REF)).toBeNull();
    expect(svc.searchCurrent({ namespace: 'command' })).toHaveLength(0);

    // Retained in history.
    const history = svc.getHistory(REF);
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe(SourceStatus.INVALID);
  });

  it('conflict: two conflicting sources -> CONFLICTED state, never silently picked', async () => {
    await svc.createRevision({
      ...REF,
      value: 'vip.trade',
      summary: 'trade permission = vip.trade',
      authority: 'indexer',
      evidence: [
        {
          sourceArtifactId: 'config:trade.yml',
          sourceVersion: 'abc',
          evidenceRole: EvidenceRole.PRIMARY,
        },
      ],
    });

    const conflicted = await svc.reportConflict({
      ...REF,
      authority: 'indexer',
      note: 'deployed config says MEMBER, live lookup says VIP',
      conflictingEvidence: [
        {
          sourceArtifactId: 'live:permission-service',
          sourceVersion: '2026-10-03T20:00:00Z',
          evidenceRole: EvidenceRole.CONTRADICTING,
        },
      ],
    });
    expect(conflicted.status).toBe(SourceStatus.CONFLICTED);

    // Normal current retrieval returns nothing — uncertainty, not a guess.
    expect(svc.getCurrent(REF)).toBeNull();
    expect(svc.searchCurrent({ namespace: 'command' })).toHaveLength(0);

    // Explicit opt-in surfaces the conflict with both evidence sides.
    const withConflict = svc.getCurrent(REF, { includeConflicted: true });
    expect(withConflict).not.toBeNull();
    expect(withConflict!.revision.status).toBe(SourceStatus.CONFLICTED);
    const roles = withConflict!.revision.evidence
      .map((e) => e.evidenceRole)
      .sort();
    expect(roles).toEqual([EvidenceRole.CONTRADICTING, EvidenceRole.PRIMARY]);

    // Resolving the conflict supersedes it back to a single CURRENT.
    const resolved = await svc.supersede({
      ...REF,
      value: 'member.trade',
      summary: 'trade permission = member.trade (live lookup won)',
      authority: 'staff:lincoln',
      reason: 'conflict resolved via live lookup',
    });
    expect(resolved.current.status).toBe(SourceStatus.CURRENT);
    expect(resolved.previous.status).toBe(SourceStatus.SUPERSEDED);
    expect(svc.getCurrent(REF)!.revision.value).toBe('member.trade');
  });

  it('history: both A and B retrievable in history mode', async () => {
    const a = await svc.createRevision({
      ...REF,
      value: 'vip.trade',
      summary: 'v1',
      authority: 'indexer',
    });
    const b = await svc.supersede({
      ...REF,
      value: 'member.trade',
      summary: 'v2',
      authority: 'indexer',
    });
    const c = await svc.supersede({
      ...REF,
      value: 'enthusia.trade',
      summary: 'v3',
      authority: 'indexer',
    });

    const history = svc.getHistory(REF);
    expect(history.map((r) => r.id)).toEqual([
      c.current.id,
      b.current.id,
      a.revision.id,
    ]);
    expect(history.map((r) => r.status)).toEqual([
      SourceStatus.CURRENT,
      SourceStatus.SUPERSEDED,
      SourceStatus.SUPERSEDED,
    ]);
    expect(history.map((r) => r.value)).toEqual([
      'enthusia.trade',
      'member.trade',
      'vip.trade',
    ]);

    // Supersession chain is walkable both directions.
    expect(c.previous.id).toBe(b.current.id);
    expect(c.previous.supersedesRevisionId).toBe(a.revision.id);
    expect(b.previous.supersededByRevisionId).toBe(b.current.id);
  });

  it('current-only search: SUPERSEDED/INVALID/STALE excluded by default', async () => {
    await svc.createRevision({
      ...REF,
      value: 'vip.trade',
      summary: 'old trade permission wording',
      authority: 'indexer',
    });
    const other: MemoryRef = { namespace: 'command', key: 'fly.permission', scope: 'smp' };
    await svc.createRevision({
      ...other,
      value: 'legend.fly',
      summary: 'fly permission = legend.fly',
      authority: 'indexer',
    });

    // Supersede the trade key: its old summary must vanish from current search.
    await svc.supersede({
      ...REF,
      value: 'enthusia.trade',
      summary: 'new trade permission wording',
      authority: 'indexer',
    });

    const all = svc.searchCurrent({ namespace: 'command' });
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.key.key).sort()).toEqual(['fly.permission', 'trade.permission']);

    // The old wording is not searchable as current — only via explicit history.
    expect(svc.searchCurrent({ text: 'old trade permission wording' })).toHaveLength(0);
    const hist = svc.searchHistory({ text: 'old trade permission wording' });
    expect(hist).toHaveLength(1);
    expect(hist[0]!.status).toBe(SourceStatus.SUPERSEDED);

    // Invalidating the fly key removes it from current search too.
    await svc.invalidate({ ...other, reason: 'removed', authority: 'staff:lincoln' });
    expect(svc.searchCurrent({ namespace: 'command' })).toHaveLength(1);

    // STALE is likewise excluded.
    await svc.markStale(REF, { reason: 'source hash changed', authority: 'indexer' });
    expect(svc.searchCurrent({ namespace: 'command' })).toHaveLength(0);
    expect(svc.getCurrent(REF)).toBeNull();
  });

  it('re-verifying a STALE revision restores it to the current view', async () => {
    await svc.createRevision({
      ...REF,
      value: 'vip.trade',
      summary: 'trade permission = vip.trade',
      authority: 'indexer',
    });
    await svc.markStale(REF, { reason: 'source fingerprint requires recheck', authority: 'indexer' });
    expect(svc.getCurrent(REF)).toBeNull();

    const verified = await svc.verify(REF, { authority: 'live-config-check' });
    expect(verified.status).toBe(SourceStatus.CURRENT);
    expect(verified.verifiedAt).toBeDefined();
    expect(svc.getCurrent(REF)?.revision.id).toBe(verified.id);
  });

  it('a STALE revision can be superseded directly by newly verified truth', async () => {
    const original = await svc.createRevision({
      ...REF,
      value: 'vip.trade',
      summary: 'trade permission = vip.trade',
      authority: 'indexer',
    });
    await svc.markStale(REF, { reason: 'config changed', authority: 'indexer' });

    const changed = await svc.supersede({
      ...REF,
      value: 'member.trade',
      summary: 'trade permission = member.trade',
      authority: 'live-config-check',
      reason: 'answer-time verification found the replacement',
    });

    expect(changed.previous.id).toBe(original.revision.id);
    expect(changed.previous.status).toBe(SourceStatus.SUPERSEDED);
    expect(changed.current.status).toBe(SourceStatus.CURRENT);
    expect(svc.getCurrent(REF)?.revision.value).toBe('member.trade');
  });

  it('race/concurrency: parallel updates produce exactly one CURRENT', async () => {
    await svc.createRevision({
      ...REF,
      value: 'v0',
      summary: 'v0',
      authority: 'indexer',
    });

    // Ten racing supersessions, no compare-and-set: each must serialize and
    // build on the latest current. Exactly one CURRENT must survive.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        svc.supersede({
          ...REF,
          value: `v${i + 1}`,
          summary: `v${i + 1}`,
          authority: 'indexer',
        }),
      ),
    );
    expect(results).toHaveLength(10);

    const history = svc.getHistory(REF);
    expect(history).toHaveLength(11);
    expect(history.filter((r) => r.status === SourceStatus.CURRENT)).toHaveLength(1);

    const current = svc.getCurrent(REF);
    expect(current).not.toBeNull();
    expect(history[0]!.id).toBe(current!.revision.id);

    // The chain is unbroken: every revision supersedes exactly its predecessor.
    const byId = new Map(history.map((r) => [r.id, r]));
    let cursor: string | undefined = current!.revision.supersedesRevisionId;
    let steps = 0;
    while (cursor) {
      const prev = byId.get(cursor);
      expect(prev).toBeDefined();
      expect(prev!.status).toBe(SourceStatus.SUPERSEDED);
      cursor = prev!.supersedesRevisionId;
      steps += 1;
    }
    expect(steps).toBe(10);
  });

  it('race/concurrency: compare-and-set rejects a stale expected current', async () => {
    const a = await svc.createRevision({
      ...REF,
      value: 'v0',
      summary: 'v0',
      authority: 'indexer',
    });
    const staleId = a.revision.id;

    // One honest supersession first.
    await svc.supersede({
      ...REF,
      value: 'v1',
      summary: 'v1',
      authority: 'indexer',
    });

    // Now a caller holding the stale id must be refused.
    await expect(
      svc.supersede({
        ...REF,
        value: 'v2',
        summary: 'v2',
        authority: 'indexer',
        expectedCurrentRevisionId: staleId,
      }),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);

    expect(svc.getHistory(REF).filter((r) => r.status === SourceStatus.CURRENT)).toHaveLength(1);

    // And two racing writers with the same expected id: exactly one wins.
    const currentId = svc.getCurrent(REF)!.revision.id;
    const outcomes = await Promise.allSettled([
      svc.supersede({
        ...REF,
        value: 'race-a',
        summary: 'race-a',
        authority: 'indexer',
        expectedCurrentRevisionId: currentId,
      }),
      svc.supersede({
        ...REF,
        value: 'race-b',
        summary: 'race-b',
        authority: 'indexer',
        expectedCurrentRevisionId: currentId,
      }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConcurrentModificationError,
    );
    expect(svc.getHistory(REF).filter((r) => r.status === SourceStatus.CURRENT)).toHaveLength(1);
  });

  it('race/concurrency: two separate connections cannot create two CURRENTs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-race-'));
    const path = join(dir, 'memory.db');
    const svcA = new MemoryService({ path });
    const svcB = new MemoryService({ path });
    try {
      await svcA.createRevision({
        ...REF,
        value: 'v0',
        summary: 'v0',
        authority: 'indexer',
      });
      const currentId = svcB.getCurrent(REF)!.revision.id;
      const outcomes = await Promise.allSettled([
        svcA.supersede({
          ...REF,
          value: 'conn-a',
          summary: 'conn-a',
          authority: 'indexer',
          expectedCurrentRevisionId: currentId,
        }),
        svcB.supersede({
          ...REF,
          value: 'conn-b',
          summary: 'conn-b',
          authority: 'indexer',
          expectedCurrentRevisionId: currentId,
        }),
      ]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      // The loser either hits compare-and-set or the unique index — either
      // way it must not silently create a second CURRENT.
      const history = svcA.getHistory(REF);
      expect(history.filter((r) => r.status === SourceStatus.CURRENT)).toHaveLength(1);
      expect(svcB.getCurrent(REF)!.revision.id).toBe(
        svcA.getCurrent(REF)!.revision.id,
      );
    } finally {
      svcA.close();
      svcB.close();
    }
  });

  it('evidence preservation: evidence links survive supersession', async () => {
    const a = await svc.createRevision({
      ...REF,
      value: 'vip.trade',
      summary: 'trade permission = vip.trade',
      authority: 'indexer',
      evidence: [
        {
          sourceArtifactId: 'config:trade.yml',
          sourceVersion: 'abc',
          evidenceRole: EvidenceRole.PRIMARY,
          authorityLevel: 'deployed config',
        },
      ],
    });

    const { current } = await svc.supersede({
      ...REF,
      value: 'member.trade',
      summary: 'trade permission = member.trade',
      authority: 'indexer',
      inheritEvidence: true,
      evidence: [
        {
          sourceArtifactId: 'config:trade.yml',
          sourceVersion: 'def',
          evidenceRole: EvidenceRole.SUPERSEDING,
        },
      ],
    });

    // Old revision's evidence is untouched by supersession.
    const oldEvidence = svc.getEvidenceForRevision(a.revision.id);
    expect(oldEvidence).toHaveLength(1);
    expect(oldEvidence[0]!.sourceArtifactId).toBe('config:trade.yml');
    expect(oldEvidence[0]!.sourceVersion).toBe('abc');

    // New revision carries the inherited provenance plus its own evidence.
    const newEvidence = svc.getEvidenceForRevision(current.id);
    const versions = newEvidence.map((e) => e.sourceVersion).sort();
    expect(versions).toEqual(['abc', 'def']);
    expect(
      newEvidence.find((e) => e.sourceVersion === 'def')!.evidenceRole,
    ).toBe(EvidenceRole.SUPERSEDING);

    // Revision rows keep their evidence references.
    const fetched = svc.getRevision(current.id);
    expect(fetched.evidenceReferences).toHaveLength(2);
  });

  it('correction API: correction creates a provenanced revision and supersedes', async () => {
    await svc.createRevision({
      ...REF,
      value: 'vip.trade',
      summary: 'trade permission = vip.trade',
      authority: 'indexer',
    });

    const events: string[] = [];
    svc.on('memory.superseded', () => events.push('superseded'));

    const { previous, current } = await svc.correct({
      ...REF,
      value: 'member.trade',
      summary: 'trade permission = member.trade',
      actor: 'staff:lincoln',
      reason: 'VIP rank no longer grants trade',
    });

    expect(current.status).toBe(SourceStatus.CURRENT);
    expect(current.authority).toBe('correction:staff:lincoln');
    expect(previous.status).toBe(SourceStatus.SUPERSEDED);
    expect(svc.getCurrent(REF)!.revision.value).toBe('member.trade');
    expect(events).toEqual(['superseded']);

    // Correction provenance is recorded in the durable event log.
    const logged = svc
      .getEvents(REF)
      .find((e) => e.type === 'memory.superseded');
    expect(logged).toBeDefined();
    expect(String(logged!.payload['reason'])).toContain('staff:lincoln');
    expect(String(logged!.payload['reason'])).toContain('VIP rank no longer grants trade');

    // Corrections require actor and reason.
    await expect(
      svc.correct({
        ...REF,
        value: 'x',
        summary: 'x',
        actor: '',
        reason: 'nope',
      }),
    ).rejects.toThrow();
  });

  it('cache invalidation hooks and event stream fire on every mutation', async () => {
    const invalidated: { ref: MemoryRef; revisionId: string }[] = [];
    const seen: string[] = [];
    const svc2 = makeService();
    try {
      svc2.registerCacheInvalidator((ref, revisionId) => {
        invalidated.push({ ref, revisionId });
      });
      svc2.on('memory.changed', (e) => seen.push(e.type));

      const created = await svc2.createRevision({
        ...REF,
        value: 'v0',
        summary: 'v0',
        authority: 'indexer',
      });
      await svc2.supersede({ ...REF, value: 'v1', summary: 'v1', authority: 'indexer' });
      await svc2.verify(REF, { authority: 'indexer' });
      await svc2.invalidate({ ...REF, reason: 'gone', authority: 'staff:lincoln' });

      expect(invalidated).toHaveLength(4);
      expect(invalidated[1]!.revisionId).not.toBe(created.revision.id);
      expect(seen).toEqual([
        'memory.created',
        'memory.superseded',
        'memory.verified',
        'memory.invalidated',
      ]);

      const logged = svc2.getEvents(REF).map((e) => e.type);
      expect(logged).toEqual([
        'memory.invalidated',
        'memory.verified',
        'memory.superseded',
        'memory.created',
      ]);
    } finally {
      svc2.close();
    }
  });

  it('visibility defaults and key identity are stable', async () => {
    const created = await svc.createRevision({
      namespace: 'rank',
      key: 'legend.fly',
      scope: 'smp',
      visibility: Visibility.PUBLIC,
      value: true,
      summary: 'legend can fly',
      authority: 'indexer',
    });
    expect(created.key.visibility).toBe(Visibility.PUBLIC);
    expect(created.key.namespace).toBe('rank');

    // Same tuple returns the same key row.
    const again = svc.ensureKey({ namespace: 'rank', key: 'legend.fly', scope: 'smp' });
    expect(again.id).toBe(created.key.id);

    // Unknown key lookups return null, not throw.
    expect(svc.getCurrent({ namespace: 'nope', key: 'nope', scope: 'nope' })).toBeNull();
    expect(svc.findKey({ namespace: 'nope', key: 'nope', scope: 'nope' })).toBeNull();
  });

  it('supersede/invalidate on a missing key throws a clear error', async () => {
    await expect(
      svc.supersede({
        namespace: 'nope',
        key: 'nope',
        scope: 'nope',
        value: 1,
        summary: 'x',
        authority: 'indexer',
      }),
    ).rejects.toBeInstanceOf(MemoryKeyNotFoundError);
    await expect(
      svc.invalidate({ namespace: 'nope', key: 'nope', scope: 'nope', reason: 'x', authority: 'y' }),
    ).rejects.toBeInstanceOf(MemoryKeyNotFoundError);

    // Key exists but has no active revision (invalidated already).
    await svc.createRevision({
      ...REF,
      value: 'v0',
      summary: 'v0',
      authority: 'indexer',
    });
    await svc.invalidate({ ...REF, reason: 'gone', authority: 'staff:lincoln' });
    await expect(
      svc.supersede({ ...REF, value: 'v1', summary: 'v1', authority: 'indexer' }),
    ).rejects.toBeInstanceOf(NoActiveRevisionError);
  });

  it('notifies observers only after the write is visible to another connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'enthusia-memory-postcommit-'));
    const dbPath = join(dir, 'memory.db');
    const writer = new MemoryService({ path: dbPath });
    const reader = new MemoryService({ path: dbPath });
    try {
      let observed: unknown = null;
      writer.registerCacheInvalidator(() => {
        observed = reader.getCurrent(REF)?.revision.value ?? null;
      });

      await writer.createRevision({
        ...REF,
        value: 'v0',
        summary: 'v0',
        authority: 'indexer',
      });

      expect(observed).toBe('v0');
    } finally {
      writer.close();
      reader.close();
    }
  });

  it('does not report a committed mutation as failed when an event observer throws', async () => {
    svc.on('memory.changed', () => {
      throw new Error('observer boom');
    });

    await expect(
      svc.createRevision({
        ...REF,
        value: 'v0',
        summary: 'v0',
        authority: 'indexer',
      }),
    ).resolves.toBeDefined();

    expect(svc.getCurrent(REF)?.revision.value).toBe('v0');
    expect(svc.getEvents(REF).map((event) => event.type)).toContain('memory.created');
  });
});
