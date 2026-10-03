/**
 * @enthusia/knowledge-indexer — lexical / exact search.
 *
 * Spec: MASTER-SPECIFICATION.md §39 — vector similarity alone is
 * insufficient for command names, permission nodes, exact config keys,
 * player UUIDs, and version strings. This index covers the lexical side of
 * hybrid retrieval: token BM25-lite scoring plus verbatim identifier
 * matching with an exact-match bonus.
 */

import { tokenize } from './embeddings.js';

export interface LexicalHit {
  /** Chunk ID. */
  id: string;
  /** Lexical score, 0..1 (BM25-lite normalized + exact-match bonus, capped). */
  score: number;
  /** True when a verbatim §39 identifier from the query matched this chunk. */
  exactMatch: boolean;
}

/**
 * Lexical search backend over indexed chunk text.
 *
 * Like `VectorStore`, `search` applies `idFilter` before scoring so
 * visibility and current-only filters are enforced pre-search.
 */
export interface LexicalIndex {
  readonly name: string;
  add(docs: { id: string; text: string }[]): void;
  remove(ids: string[]): void;
  clear(): void;
  count(): number;
  search(query: string, topK: number, idFilter?: (id: string) => boolean): LexicalHit[];
}

/** Identifier classes from spec §39 that need verbatim matching. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const DOTTED_RE = /\b[a-z0-9_][a-z0-9_.-]*\.[a-z0-9_.-]+\b/i; // permission nodes, config keys
const SLASH_COMMAND_RE = /(^|\s)(\/[a-z0-9_-]+)/i; // /staff, /vanish, ...
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][0-9a-z.-]+)?\b/i; // 1.21.4, v2.3.1, 26.2

/**
 * Extract verbatim-matchable identifiers from a query string.
 *
 * Returns lowercased canonical forms: UUIDs, dotted permission/config keys,
 * slash commands (with and without the leading slash), and version strings.
 */
export function extractIdentifiers(query: string): string[] {
  const found = new Set<string>();
  const globalize = (re: RegExp) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');

  let m: RegExpExecArray | null;
  const uuidRe = globalize(UUID_RE);
  while ((m = uuidRe.exec(query)) !== null) found.add(m[0].toLowerCase());

  const dottedRe = globalize(DOTTED_RE);
  while ((m = dottedRe.exec(query)) !== null) found.add(m[0].toLowerCase());

  const cmdRe = globalize(SLASH_COMMAND_RE);
  while ((m = cmdRe.exec(query)) !== null) {
    // Verbatim slash form only: the bare token ('staff') already matches
    // via BM25, so only the exact '/staff' spelling earns the bonus.
    found.add((m[2] as string).toLowerCase());
  }

  const verRe = globalize(VERSION_RE);
  while ((m = verRe.exec(query)) !== null) found.add(m[0].toLowerCase());

  return [...found];
}

/**
 * In-memory inverted index with BM25-lite scoring and §39 exact-match boost.
 *
 * Scoring per document: sum over query terms of
 *   idf(t) * tf(t,d) / (tf(t,d) + k1),
 * with idf = ln(1 + (N - df + 0.5) / (df + 0.5)), normalized to 0..1 across
 * the result set. A verbatim identifier match adds EXACT_MATCH_BONUS
 * (capped at 1.0) and sets `exactMatch: true` on the hit.
 */
export class InMemoryLexicalIndex implements LexicalIndex {
  readonly name = 'in-memory-lexical';
  /** Bonus added to the normalized score on verbatim identifier match. */
  static readonly EXACT_MATCH_BONUS = 0.35;
  private static readonly K1 = 1.2;

  private readonly docs = new Map<string, { tokens: string[]; textLower: string }>();
  private readonly postings = new Map<string, Map<string, number>>();

  add(docs: { id: string; text: string }[]): void {
    for (const doc of docs) {
      this.remove([doc.id]);
      const tokens = tokenize(doc.text);
      const counts = new Map<string, number>();
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      this.docs.set(doc.id, { tokens, textLower: doc.text.toLowerCase() });
      for (const [term, tf] of counts) {
        let posting = this.postings.get(term);
        if (!posting) {
          posting = new Map();
          this.postings.set(term, posting);
        }
        posting.set(doc.id, tf);
      }
    }
  }

  remove(ids: string[]): void {
    for (const id of ids) {
      const doc = this.docs.get(id);
      if (!doc) continue;
      const seen = new Set(doc.tokens);
      for (const term of seen) {
        const posting = this.postings.get(term);
        if (posting) {
          posting.delete(id);
          if (posting.size === 0) this.postings.delete(term);
        }
      }
      this.docs.delete(id);
    }
  }

  clear(): void {
    this.docs.clear();
    this.postings.clear();
  }

  count(): number {
    return this.docs.size;
  }

  search(query: string, topK: number, idFilter?: (id: string) => boolean): LexicalHit[] {
    if (topK <= 0) return [];
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];
    const identifiers = extractIdentifiers(query);

    const n = this.docs.size;
    if (n === 0) return [];

    const raw = new Map<string, number>();
    const seenTerms = new Set(queryTerms);
    for (const term of seenTerms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = posting.size;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const [docId, tf] of posting) {
        if (idFilter && !idFilter(docId)) continue;
        const sat = tf / (tf + InMemoryLexicalIndex.K1);
        raw.set(docId, (raw.get(docId) ?? 0) + idf * sat);
      }
    }

    // Verbatim identifier matches (§39): scan eligible docs for the raw
    // identifier string. Eligible = passed the idFilter (or in raw when no
    // filter); docs with no token overlap can still win on exact match.
    const exactIds = new Set<string>();
    if (identifiers.length > 0) {
      for (const [docId, doc] of this.docs) {
        if (idFilter && !idFilter(docId)) continue;
        for (const ident of identifiers) {
          if (doc.textLower.includes(ident)) {
            exactIds.add(docId);
            if (!raw.has(docId)) raw.set(docId, 0);
            break;
          }
        }
      }
    }

    if (raw.size === 0) return [];
    let max = 0;
    for (const s of raw.values()) if (s > max) max = s;

    const hits: LexicalHit[] = [];
    for (const [id, s] of raw) {
      const exact = exactIds.has(id);
      const normalized = max > 0 ? s / max : 0;
      const score = Math.min(1, normalized + (exact ? InMemoryLexicalIndex.EXACT_MATCH_BONUS : 0));
      hits.push({ id, score, exactMatch: exact });
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.exactMatch) - Number(a.exactMatch) ||
        (a.id < b.id ? -1 : 1),
    );
    return hits.slice(0, topK);
  }
}
