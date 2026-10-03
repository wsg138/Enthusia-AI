/**
 * W07 — Knowledge retrieval engine tests.
 *
 * Covers: chunking, vector store, lexical/exact search (§39), hybrid
 * ranking, current-only default (NON-NEGOTIABLE), explicit historical
 * opt-in, visibility-ceiling enforcement, metadata filters, provenance,
 * and SQLite persistence.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 39;
 * MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §§13-15;
 * WORKER-EXECUTION-PLAN.md §10.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SourceStatus, SourceType, Visibility } from '@enthusia/contracts';
import {
  FixedWindowChunker,
  HashingEmbeddingProvider,
  HybridRanker,
  type EmbeddingProvider,
  InMemoryLexicalIndex,
  InMemoryVectorStore,
  KnowledgeRetrievalEngine,
  SqliteChunkStore,
  MarkdownSectionChunker,
  cosineSimilarity,
  extractIdentifiers,
  type KnowledgeChunk,
  type SearchOptions,
} from '../src/retrieval/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<KnowledgeChunk> & { chunkId: string }): KnowledgeChunk {
  return {
    artifactId: 'artifact-1',
    version: 'v1',
    status: SourceStatus.CURRENT,
    visibility: Visibility.PUBLIC,
    sourceType: SourceType.DOCUMENT,
    component: 'knowledge-indexer',
    authority: 'test',
    sourceLocator: 'test:artifact-1',
    text: 'default chunk text',
    chunkIndex: 0,
    ...overrides,
  };
}

function makeEngine(sqlitePath = ':memory:') {
  const dimension = 64;
  const engine = new KnowledgeRetrievalEngine({
    chunkStore: new SqliteChunkStore(sqlitePath),
    vectorStore: new InMemoryVectorStore(dimension),
    lexicalIndex: new InMemoryLexicalIndex(),
    embeddingProvider: new HashingEmbeddingProvider({ dimension }),
    defaultChunker: new FixedWindowChunker({ maxChars: 500, overlapChars: 50 }),
  });
  return engine;
}

const PUBLIC_SEARCH: SearchOptions = { visibilityCeiling: Visibility.PUBLIC };

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

describe('FixedWindowChunker', () => {
  it('returns no chunks for empty text', () => {
    expect(new FixedWindowChunker().chunk('')).toEqual([]);
    expect(new FixedWindowChunker().chunk('   ')).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    const chunks = new FixedWindowChunker({ maxChars: 1200 }).chunk('Hello world. Short.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('Hello world. Short.');
    expect(chunks[0]?.charStart).toBe(0);
  });

  it('bounds chunk size and is deterministic', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about the Enthusia server rules.`).join(' ');
    const chunker = new FixedWindowChunker({ maxChars: 400, overlapChars: 50 });
    const a = chunker.chunk(text);
    const b = chunker.chunk(text);
    expect(a.length).toBeGreaterThan(1);
    for (const c of a) expect(c.text.length).toBeLessThanOrEqual(400);
    expect(a).toEqual(b);
    // No content lost: every sentence appears in at least one chunk.
    for (let i = 0; i < 60; i++) {
      expect(a.some((c) => c.text.includes(`Sentence number ${i} `))).toBe(true);
    }
  });

  it('hard-splits a single over-long sentence', () => {
    const text = `word `.repeat(500).trim();
    const chunks = new FixedWindowChunker({ maxChars: 200, overlapChars: 0 }).chunk(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(200);
  });

  it('rejects invalid options', () => {
    expect(() => new FixedWindowChunker({ maxChars: 0 })).toThrow();
    expect(() => new FixedWindowChunker({ maxChars: 100, overlapChars: 100 })).toThrow();
  });
});

describe('MarkdownSectionChunker', () => {
  it('splits on headings and records them', () => {
    const text = '# Rules\n\nBe kind.\n\n# Commands\n\nUse /help for help.';
    const chunks = new MarkdownSectionChunker().chunk(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.heading).toBe('Rules');
    expect(chunks[1]?.heading).toBe('Commands');
    expect(chunks[1]?.text).toContain('/help');
  });

  it('windows oversized sections', () => {
    const body = `word `.repeat(2000);
    const text = `# Big\n\n${body}`;
    const chunks = new MarkdownSectionChunker({ maxChars: 300, overlapChars: 0, maxSectionChars: 500 }).chunk(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.heading).toBe('Big');
  });
});

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

describe('InMemoryVectorStore', () => {
  it('ranks by cosine similarity', async () => {
    const store = new InMemoryVectorStore(3);
    await store.upsert([
      { id: 'a', vector: [1, 0, 0] },
      { id: 'b', vector: [0, 1, 0] },
      { id: 'c', vector: [0.7, 0.7, 0] },
    ]);
    const hits = await store.search([1, 0, 0], 3);
    expect(hits.map((h) => h.id)).toEqual(['a', 'c', 'b']);
    expect(hits[0]?.score).toBeCloseTo(1, 5);
  });

  it('applies the id filter before scoring', async () => {
    const store = new InMemoryVectorStore(2);
    await store.upsert([
      { id: 'secret', vector: [1, 0] },
      { id: 'open', vector: [0.9, 0.1] },
    ]);
    const hits = await store.search([1, 0], 10, (id) => id !== 'secret');
    expect(hits.map((h) => h.id)).toEqual(['open']);
  });

  it('rejects dimension mismatches', async () => {
    const store = new InMemoryVectorStore(2);
    await expect(store.upsert([{ id: 'x', vector: [1, 2, 3] }])).rejects.toThrow();
    await expect(store.search([1], 5)).rejects.toThrow();
  });

  it('supports remove, clear, and count', async () => {
    const store = new InMemoryVectorStore(2);
    await store.upsert([
      { id: 'a', vector: [1, 0] },
      { id: 'b', vector: [0, 1] },
    ]);
    expect(await store.count()).toBe(2);
    await store.remove(['a', 'missing']);
    expect(await store.count()).toBe(1);
    await store.clear();
    expect(await store.count()).toBe(0);
    expect(await store.search([1, 0], 5)).toEqual([]);
  });

  it('cosineSimilarity clamps and validates', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Lexical / exact search (§39)
// ---------------------------------------------------------------------------

describe('extractIdentifiers', () => {
  it('extracts UUIDs, dotted keys, slash commands, and versions', () => {
    const ids = extractIdentifiers(
      'Who has permission enthusia.staff.freeze? /staff on 550e8400-e29b-41d4-a716-446655440000 running 1.21.4',
    );
    expect(ids).toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(ids).toContain('enthusia.staff.freeze');
    expect(ids).toContain('/staff');
    expect(ids).toContain('1.21.4');
    // The bare token 'staff' is NOT a verbatim identifier — it already
    // matches via BM25 token scoring; only '/staff' earns the exact bonus.
    expect(ids).not.toContain('staff');
  });

  it('returns nothing for plain prose', () => {
    expect(extractIdentifiers('What is the server IP address?')).toEqual([]);
  });
});

describe('InMemoryLexicalIndex', () => {
  it('verbatim command match outranks mere token overlap and sets exactMatch', () => {
    const idx = new InMemoryLexicalIndex();
    idx.add([
      { id: 'verbatim', text: 'Run /staff to enter staff mode. The /staff command toggles duty status.' },
      { id: 'prose', text: 'Our staff team works hard. Staff members handle tickets daily.' },
    ]);
    const hits = idx.search('/staff', 10);
    expect(hits[0]?.id).toBe('verbatim');
    expect(hits[0]?.exactMatch).toBe(true);
    const prose = hits.find((h) => h.id === 'prose');
    expect(prose?.exactMatch).toBe(false);
  });

  it('matches UUIDs verbatim', () => {
    const idx = new InMemoryLexicalIndex();
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    idx.add([
      { id: 'hit', text: `Player ${uuid} was frozen by staff.` },
      { id: 'miss', text: 'A player was frozen by staff yesterday.' },
    ]);
    const hits = idx.search(`freeze history for ${uuid}`, 10);
    expect(hits[0]?.id).toBe('hit');
    expect(hits[0]?.exactMatch).toBe(true);
  });

  it('matches permission nodes and config keys verbatim', () => {
    const idx = new InMemoryLexicalIndex();
    idx.add([
      { id: 'perm', text: 'Grant enthusia.staff.vanish to moderators via LuckPerms.' },
      { id: 'other', text: 'Vanish hides staff from the player list.' },
    ]);
    const hits = idx.search('who has enthusia.staff.vanish', 10);
    expect(hits[0]?.id).toBe('perm');
    expect(hits[0]?.exactMatch).toBe(true);
  });

  it('applies the id filter before scoring', () => {
    const idx = new InMemoryLexicalIndex();
    idx.add([
      { id: 'hidden', text: 'exact secret phrase alpha' },
      { id: 'shown', text: 'exact secret phrase alpha' },
    ]);
    const hits = idx.search('exact secret phrase alpha', 10, (id) => id === 'shown');
    expect(hits.map((h) => h.id)).toEqual(['shown']);
  });

  it('supports remove/clear/count', () => {
    const idx = new InMemoryLexicalIndex();
    idx.add([{ id: 'a', text: 'hello world' }]);
    expect(idx.count()).toBe(1);
    idx.remove(['a']);
    expect(idx.count()).toBe(0);
    expect(idx.search('hello', 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hybrid ranking
// ---------------------------------------------------------------------------

describe('HybridRanker', () => {
  it('combines signals with weights', () => {
    const ranker = new HybridRanker({ weights: { vector: 1, lexical: 0 } });
    const ranked = ranker.rank([
      { chunkId: 'a', vectorScore: 0.2, exactMatch: false },
      { chunkId: 'b', vectorScore: 0.9, exactMatch: false },
    ]);
    expect(ranked.map((r) => r.chunkId)).toEqual(['b', 'a']);
    expect(ranked[0]?.score).toBeCloseTo(1, 5);
  });

  it('lets a strong lexical signal beat a weak vector one at default weights', () => {
    const ranker = new HybridRanker();
    const ranked = ranker.rank([
      { chunkId: 'vec', vectorScore: 0.9, lexicalScore: 0.1, exactMatch: false },
      { chunkId: 'lex', vectorScore: 0.1, lexicalScore: 0.9, exactMatch: false },
    ]);
    // Symmetric inputs at 50/50 weights tie; exact match breaks the tie.
    const withExact = ranker.rank([
      { chunkId: 'vec', vectorScore: 0.9, lexicalScore: 0.1, exactMatch: false },
      { chunkId: 'lex', vectorScore: 0.1, lexicalScore: 0.9, exactMatch: true },
    ]);
    expect(withExact[0]?.chunkId).toBe('lex');
    expect(ranked).toHaveLength(2);
  });

  it('supports a per-call weight override', () => {
    const ranker = new HybridRanker();
    const candidates = [
      { chunkId: 'vector', vectorScore: 1, lexicalScore: 0.1, exactMatch: false },
      { chunkId: 'lexical', vectorScore: 0.1, lexicalScore: 1, exactMatch: false },
    ];
    expect(ranker.rank(candidates, { vector: 1, lexical: 0 })[0]?.chunkId).toBe('vector');
    expect(ranker.rank(candidates, { vector: 0, lexical: 1 })[0]?.chunkId).toBe('lexical');
  });

  it('returns empty for no candidates and rejects bad weights', () => {
    expect(new HybridRanker().rank([])).toEqual([]);
    expect(() => new HybridRanker({ weights: { vector: 0, lexical: 0 } })).toThrow();
    expect(() =>
      new HybridRanker().rank(
        [{ chunkId: 'x', vectorScore: 1, exactMatch: false }],
        { vector: 0, lexical: 0 },
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Engine: current-only default (NON-NEGOTIABLE)
// ---------------------------------------------------------------------------

describe('KnowledgeRetrievalEngine — current-only default', () => {
  it('excludes SUPERSEDED chunks by default, even when they match best', async () => {
    const engine = makeEngine();
    await engine.indexChunks([
      makeChunk({
        chunkId: 'rules#0',
        artifactId: 'rules',
        version: 'sha-old',
        text: 'The server IP is play.enthusia.example and the port is 25565 for Java edition players.',
      }),
      makeChunk({
        chunkId: 'rules#1',
        artifactId: 'rules-v2',
        version: 'sha-new',
        text: 'Unrelated note about community events and build contests on the server.',
      }),
    ]);
    await engine.updateArtifactStatus('rules', SourceStatus.SUPERSEDED);

    const res = await engine.search('What is the server IP and port?', PUBLIC_SEARCH);
    expect(res.effectiveStatuses).toEqual([SourceStatus.CURRENT]);
    expect(res.historicalMode).toBe(false);
    // The superseded chunk is the best textual match but must NOT appear.
    expect(res.results.some((h) => h.chunk.chunkId === 'rules#0')).toBe(false);
    expect(res.results.some((h) => h.chunk.chunkId === 'rules#1')).toBe(true);
    engine.close();
  });

  it('excludes INVALID and STALE chunks by default', async () => {
    const engine = makeEngine();
    await engine.indexChunks([
      makeChunk({ chunkId: 'a#0', artifactId: 'a', text: 'alpha beta gamma delta' }),
      makeChunk({ chunkId: 'b#0', artifactId: 'b', text: 'alpha beta gamma delta' }),
      makeChunk({ chunkId: 'c#0', artifactId: 'c', text: 'alpha beta gamma delta' }),
    ]);
    await engine.updateArtifactStatus('b', SourceStatus.INVALID);
    await engine.updateArtifactStatus('c', SourceStatus.STALE);

    const res = await engine.search('alpha beta gamma', PUBLIC_SEARCH);
    const ids = res.results.map((h) => h.chunk.chunkId);
    expect(ids).toContain('a#0');
    expect(ids).not.toContain('b#0');
    expect(ids).not.toContain('c#0');
    engine.close();
  });

  it('includeHistorical=true returns SUPERSEDED chunks flagged as historical', async () => {
    const engine = makeEngine();
    await engine.indexChunks([
      makeChunk({ chunkId: 'old#0', artifactId: 'old', version: 'sha-old', text: 'The old server IP was 1.2.3.4 before migration.' }),
      makeChunk({ chunkId: 'new#0', artifactId: 'new', version: 'sha-new', text: 'The current server IP is play.enthusia.example.' }),
    ]);
    await engine.updateArtifactStatus('old', SourceStatus.SUPERSEDED);

    const res = await engine.search('server IP', { ...PUBLIC_SEARCH, includeHistorical: true });
    expect(res.effectiveStatuses).toEqual([SourceStatus.CURRENT, SourceStatus.SUPERSEDED]);
    expect(res.historicalMode).toBe(true);
    const oldHit = res.results.find((h) => h.chunk.chunkId === 'old#0');
    const newHit = res.results.find((h) => h.chunk.chunkId === 'new#0');
    expect(oldHit).toBeDefined();
    expect(oldHit?.historical).toBe(true);
    expect(newHit?.historical).toBe(false);
    engine.close();
  });

  it('explicit statuses override acts as explicit opt-in (incl. CONFLICTED for investigation)', async () => {
    const engine = makeEngine();
    await engine.indexChunks([
      makeChunk({ chunkId: 'x#0', artifactId: 'x', text: 'conflicted value omega' }),
    ]);
    await engine.updateArtifactStatus('x', SourceStatus.CONFLICTED);

    const def = await engine.search('omega', PUBLIC_SEARCH);
    expect(def.results).toEqual([]);

    const inv = await engine.search('omega', { ...PUBLIC_SEARCH, statuses: [SourceStatus.CONFLICTED] });
    expect(inv.results.map((h) => h.chunk.chunkId)).toEqual(['x#0']);
    expect(inv.results[0]?.historical).toBe(true);
    engine.close();
  });

  it('supersession via updateArtifactStatus is metadata-driven (no re-index)', async () => {
    const engine = makeEngine();
    await engine.indexChunks([
      makeChunk({ chunkId: 'doc#0', artifactId: 'doc', text: 'current rules text about griefing policy' }),
    ]);
    const before = await engine.search('griefing policy', PUBLIC_SEARCH);
    expect(before.results).toHaveLength(1);

    const updated = await engine.updateArtifactStatus('doc', SourceStatus.SUPERSEDED);
    expect(updated).toBe(1);
    const after = await engine.search('griefing policy', PUBLIC_SEARCH);
    expect(after.results).toEqual([]);
    expect(after.total).toBe(0);
    engine.close();
  });
});

// ---------------------------------------------------------------------------
// Engine: visibility enforcement
// ---------------------------------------------------------------------------

describe('KnowledgeRetrievalEngine — visibility', () => {
  it('filters by ceiling before results reach the caller', async () => {
    const engine = makeEngine();
    await engine.indexChunks([
      makeChunk({ chunkId: 'pub#0', artifactId: 'pub', visibility: Visibility.PUBLIC, text: 'public server rules for everyone' }),
      makeChunk({ chunkId: 'stf#0', artifactId: 'stf', visibility: Visibility.STAFF, text: 'public server rules for everyone plus staff notes' }),
    ]);

    const pubRes = await engine.search('server rules', PUBLIC_SEARCH);
    expect(pubRes.results.map((h) => h.chunk.chunkId)).toEqual(['pub#0']);

    const staffRes = await engine.search('server rules', { visibilityCeiling: Visibility.STAFF });
    expect(staffRes.results.map((h) => h.chunk.chunkId).sort()).toEqual(['pub#0', 'stf#0']);
    engine.close();
  });

  it('enforces PLAYER_SELF identity rules', async () => {
    const engine = makeEngine();
    await engine.indexChunks([
      makeChunk({ chunkId: 'self#0', artifactId: 'self', visibility: Visibility.PLAYER_SELF, text: 'your private punishment history record' }),
    ]);

    const anon = await engine.search('punishment history', { visibilityCeiling: Visibility.STAFF });
    expect(anon.results).toEqual([]);

    const subject = await engine.search('punishment history', {
      visibilityCeiling: Visibility.STAFF,
      requester: { isSubject: true },
    });
    expect(subject.results.map((h) => h.chunk.chunkId)).toEqual(['self#0']);

    const staff = await engine.search('punishment history', {
      visibilityCeiling: Visibility.STAFF,
      requester: { isStaff: true },
    });
    expect(staff.results.map((h) => h.chunk.chunkId)).toEqual(['self#0']);
    engine.close();
  });

  it('refuses to index SECRET_DENY chunks', async () => {
    const engine = makeEngine();
    await expect(
      engine.indexChunks([makeChunk({ chunkId: 'sec#0', visibility: Visibility.SECRET_DENY, text: 'token abc123' })]),
    ).rejects.toThrow(/SECRET_DENY/);
    engine.close();
  });

  it('requires an explicit visibility ceiling', async () => {
    const engine = makeEngine();
    await expect(engine.search('anything', {} as SearchOptions)).rejects.toThrow(/visibilityCeiling/);
    engine.close();
  });
});

// ---------------------------------------------------------------------------
// Engine: metadata filters, provenance, pagination
// ---------------------------------------------------------------------------

describe('KnowledgeRetrievalEngine — filters and provenance', () => {
  it('applies metadata filters (AND-combined)', async () => {
    const engine = makeEngine();
    await engine.indexChunks([
      makeChunk({ chunkId: 'a#0', artifactId: 'a', sourceType: SourceType.CONFIG, component: 'indexer-a', version: 'v1', authority: 'github', text: 'server port configuration value' }),
      makeChunk({ chunkId: 'b#0', artifactId: 'b', sourceType: SourceType.DOCUMENT, component: 'indexer-b', version: 'v2', authority: 'staff', text: 'server port configuration value' }),
    ]);

    const byType = await engine.search('server port', { ...PUBLIC_SEARCH, filters: { sourceType: SourceType.CONFIG } });
    expect(byType.results.map((h) => h.chunk.chunkId)).toEqual(['a#0']);

    const byComponent = await engine.search('server port', { ...PUBLIC_SEARCH, filters: { component: 'indexer-b' } });
    expect(byComponent.results.map((h) => h.chunk.chunkId)).toEqual(['b#0']);

    const byVersion = await engine.search('server port', { ...PUBLIC_SEARCH, filters: { version: 'v2' } });
    expect(byVersion.results.map((h) => h.chunk.chunkId)).toEqual(['b#0']);

    const byAuthority = await engine.search('server port', { ...PUBLIC_SEARCH, filters: { authority: 'github' } });
    expect(byAuthority.results.map((h) => h.chunk.chunkId)).toEqual(['a#0']);

    const combined = await engine.search('server port', {
      ...PUBLIC_SEARCH,
      filters: { sourceType: SourceType.DOCUMENT, version: 'v1' },
    });
    expect(combined.results).toEqual([]);
    engine.close();
  });

  it('returns provenance and version on every hit', async () => {
    const engine = makeEngine();
    await engine.indexChunks([
      makeChunk({
        chunkId: 'p#0',
        artifactId: 'rules-doc',
        version: 'deadbeef',
        sourceType: SourceType.DOCUMENT,
        component: 'knowledge-indexer',
        authority: 'github:wsg138/EnthusiaDocs',
        sourceLocator: 'github:wsg138/EnthusiaDocs:rules.md',
        text: 'griefing is not allowed on the server',
      }),
    ]);
    const res = await engine.search('griefing allowed?', PUBLIC_SEARCH);
    expect(res.results).toHaveLength(1);
    const hit = res.results[0];
    expect(hit?.provenance).toMatchObject({
      artifactId: 'rules-doc',
      version: 'deadbeef',
      status: SourceStatus.CURRENT,
      visibility: Visibility.PUBLIC,
      sourceType: SourceType.DOCUMENT,
      component: 'knowledge-indexer',
      authority: 'github:wsg138/EnthusiaDocs',
      sourceLocator: 'github:wsg138/EnthusiaDocs:rules.md',
      chunkId: 'p#0',
    });
    expect(hit?.score).toBeGreaterThan(0);
    expect(hit?.score).toBeLessThanOrEqual(1);
    expect(hit?.historical).toBe(false);
    engine.close();
  });

  it('supports limit/offset pagination and minScore', async () => {
    const engine = makeEngine();
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk({ chunkId: `d${i}#0`, artifactId: `d${i}`, text: `pagination probe content number ${i}` }),
    );
    await engine.indexChunks(chunks);

    const page1 = await engine.search('pagination probe', { ...PUBLIC_SEARCH, limit: 2, offset: 0 });
    const page2 = await engine.search('pagination probe', { ...PUBLIC_SEARCH, limit: 2, offset: 2 });
    expect(page1.results).toHaveLength(2);
    expect(page2.results).toHaveLength(2);
    expect(page1.total).toBe(5);
    const ids1 = new Set(page1.results.map((h) => h.chunk.chunkId));
    for (const h of page2.results) expect(ids1.has(h.chunk.chunkId)).toBe(false);

    const strict = await engine.search('pagination probe', { ...PUBLIC_SEARCH, minScore: 1.01 });
    expect(strict.results).toEqual([]);
    engine.close();
  });

  it('returns empty for blank queries', async () => {
    const engine = makeEngine();
    await engine.indexChunks([makeChunk({ chunkId: 'z#0', text: 'some content' })]);
    const res = await engine.search('   ', PUBLIC_SEARCH);
    expect(res.results).toEqual([]);
    expect(res.total).toBe(0);
    engine.close();
  });
});

// ---------------------------------------------------------------------------
// Engine: artifact indexing + SQLite persistence
// ---------------------------------------------------------------------------

describe('KnowledgeRetrievalEngine — indexing and persistence', () => {
  it('indexArtifactText chunks with provenance from the artifact', async () => {
    const engine = makeEngine();
    const long = `# Staff Guide\n\n${'Staff on duty must stay visible in Discord. '.repeat(40)}`;
    const chunks = await engine.indexArtifactText(
      {
        artifactId: 'guide-1',
        sourceType: SourceType.DOCUMENT,
        sourceLocator: 'github:wsg138/EnthusiaDocs:guide.md',
        component: 'knowledge-indexer',
        visibility: Visibility.STAFF,
        authority: 'github:wsg138/EnthusiaDocs',
        version: 'abc123',
        observedTime: new Date().toISOString(),
        indexedTime: new Date().toISOString(),
        current: true,
      },
      SourceStatus.CURRENT,
      long,
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.artifactId).toBe('guide-1');
      expect(c.version).toBe('abc123');
      expect(c.visibility).toBe(Visibility.STAFF);
      expect(c.status).toBe(SourceStatus.CURRENT);
      expect(c.chunkId.startsWith('guide-1#')).toBe(true);
      expect(c.embeddingVersion).toContain('hashing-test');
    }
    const res = await engine.search('staff on duty discord', { visibilityCeiling: Visibility.STAFF });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0]?.provenance.artifactId).toBe('guide-1');
    engine.close();
  });

  it('keeps the previous searchable state when re-embedding fails', async () => {
    const dimension = 64;
    const baseProvider = new HashingEmbeddingProvider({ dimension });
    let failEmbedding = false;
    const provider: EmbeddingProvider = {
      name: 'failable-test',
      dimension,
      version: 'failable-test-v1',
      async embed(texts: string[]): Promise<number[][]> {
        if (failEmbedding) throw new Error('embedding unavailable');
        return baseProvider.embed(texts);
      },
    };
    const engine = new KnowledgeRetrievalEngine({
      chunkStore: new SqliteChunkStore(':memory:'),
      vectorStore: new InMemoryVectorStore(dimension),
      lexicalIndex: new InMemoryLexicalIndex(),
      embeddingProvider: provider,
    });

    await engine.indexChunks([
      makeChunk({
        chunkId: 'stable#0',
        artifactId: 'stable',
        text: 'old searchable phrase',
      }),
    ]);

    failEmbedding = true;
    await expect(
      engine.indexChunks([
        makeChunk({
          chunkId: 'stable#0',
          artifactId: 'stable',
          text: 'replacement text that must not publish',
        }),
      ]),
    ).rejects.toThrow(/embedding unavailable/);

    // Restore the provider so the verification searches can embed their
    // queries; only the failed re-index operation is under test here.
    failEmbedding = false;

    const oldResult = await engine.search('old searchable phrase', PUBLIC_SEARCH);
    expect(oldResult.results[0]?.chunk.text).toBe('old searchable phrase');
    const newResult = await engine.search('replacement text', PUBLIC_SEARCH);
    expect(newResult.results.some((hit) => hit.chunk.text.includes('replacement text'))).toBe(false);
    engine.close();
  });

  it('removeArtifact drops chunks from every backend', async () => {
    const engine = makeEngine();
    await engine.indexChunks([makeChunk({ chunkId: 'gone#0', artifactId: 'gone', text: 'unique zebra phrase' })]);
    expect((await engine.search('unique zebra phrase', PUBLIC_SEARCH)).total).toBe(1);
    await engine.removeArtifact('gone');
    expect((await engine.search('unique zebra phrase', PUBLIC_SEARCH)).total).toBe(0);
    expect(engine.indexedCount()).toBe(0);
    engine.close();
  });

  it('persists chunks to SQLite and rehydrates on rebuild', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w07-test-'));
    const dbPath = join(dir, 'chunks.sqlite');
    const engine = makeEngine(dbPath);
    await engine.indexChunks([
      makeChunk({ chunkId: 'persist#0', artifactId: 'persist', version: 'v9', text: 'durable knowledge survives restarts' }),
    ]);
    engine.close();

    // Simulate a restart: fresh engine over the same SQLite file.
    const engine2 = makeEngine(dbPath);
    await engine2.rebuildIndexes();
    const res = await engine2.search('durable knowledge', PUBLIC_SEARCH);
    expect(res.results.map((h) => h.chunk.chunkId)).toEqual(['persist#0']);
    expect(res.results[0]?.provenance.version).toBe('v9');
    engine2.close();
  });
});

describe('SqliteChunkStore', () => {
  it('round-trips chunks with metadata', () => {
    const store = new SqliteChunkStore(':memory:');
    const chunk = makeChunk({
      chunkId: 'm#0',
      text: 'hello',
      tokenCount: 3,
      embeddingVersion: 'hashing-test-v1/dim64',
      metadata: { heading: 'Intro' },
    });
    store.saveChunks([chunk]);
    expect(store.count()).toBe(1);
    const got = store.getChunk('m#0');
    expect(got?.text).toBe('hello');
    expect(got?.tokenCount).toBe(3);
    expect(got?.embeddingVersion).toBe('hashing-test-v1/dim64');
    expect(got?.metadata).toEqual({ heading: 'Intro' });
    expect(store.getChunk('missing')).toBeUndefined();
    store.close();
  });

  it('updates status and lists/deletes by artifact', () => {
    const store = new SqliteChunkStore(':memory:');
    store.saveChunks([
      makeChunk({ chunkId: 's#0', artifactId: 's', chunkIndex: 0, text: 'one' }),
      makeChunk({ chunkId: 's#1', artifactId: 's', chunkIndex: 1, text: 'two' }),
      makeChunk({ chunkId: 't#0', artifactId: 't', text: 'three' }),
    ]);
    expect(store.updateStatusByArtifact('s', SourceStatus.SUPERSEDED)).toBe(2);
    expect(store.listByArtifact('s').every((c) => c.status === SourceStatus.SUPERSEDED)).toBe(true);
    expect(store.listAll()).toHaveLength(3);
    expect(store.deleteByArtifact('t')).toBe(1);
    expect(store.count()).toBe(2);
    store.clear();
    expect(store.count()).toBe(0);
    store.close();
  });

  it('throws after close', () => {
    const store = new SqliteChunkStore(':memory:');
    store.close();
    expect(() => store.count()).toThrow();
  });
});
