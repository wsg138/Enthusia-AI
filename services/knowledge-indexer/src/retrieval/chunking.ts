/**
 * @enthusia/knowledge-indexer — chunking abstractions.
 *
 * How indexed documents are split into searchable chunks. The retrieval
 * engine depends only on the `Chunker` interface; W08/W09 (indexers) choose
 * the concrete strategy per source type.
 *
 * Spec: WORKER-EXECUTION-PLAN.md §10 (W07 owns chunking abstractions).
 */

/** One cut of a document, with character offsets for traceability. */
export interface TextChunk {
  text: string;
  /** Offset of the first character in the source document. */
  charStart: number;
  /** Offset one past the last character in the source document. */
  charEnd: number;
  /** Nearest enclosing heading, when the chunker tracks document structure. */
  heading?: string;
}

/** Splits document text into searchable chunks. */
export interface Chunker {
  /** Stable name recorded for debugging/provenance. */
  readonly name: string;
  /** Split `text` into chunks. Must be deterministic for the same input. */
  chunk(text: string): TextChunk[];
}

export interface FixedWindowChunkerOptions {
  /** Target chunk size in characters. Default 1200. */
  maxChars?: number;
  /** Overlap between consecutive chunks in characters. Default 150. */
  overlapChars?: number;
}

/**
 * Sentence-aware fixed-window chunker.
 *
 * Packs whole sentences into windows up to `maxChars`; a single sentence
 * longer than `maxChars` is hard-split. Consecutive windows overlap by
 * `overlapChars` so evidence spanning a boundary is still retrievable.
 * Deterministic.
 */
export class FixedWindowChunker implements Chunker {
  readonly name = 'fixed-window';
  private readonly maxChars: number;
  private readonly overlapChars: number;

  constructor(options: FixedWindowChunkerOptions = {}) {
    const maxChars = options.maxChars ?? 1200;
    const overlapChars = options.overlapChars ?? 150;
    if (maxChars <= 0) throw new Error('maxChars must be positive');
    if (overlapChars < 0 || overlapChars >= maxChars) {
      throw new Error('overlapChars must be in [0, maxChars)');
    }
    this.maxChars = maxChars;
    this.overlapChars = overlapChars;
  }

  chunk(text: string): TextChunk[] {
    const sentences = splitSentences(text);
    if (sentences.length === 0) return [];

    const windows: { start: number; end: number }[] = [];
    let winStart = 0;
    let winEnd = 0;
    // Monotonic cursor: repeated identical pieces must resolve to their
    // true sequential positions, not the first occurrence in the sentence.
    let searchFrom = 0;
    for (const s of sentences) {
      if (s.start > searchFrom) searchFrom = s.start;
      // Hard-split an over-long sentence so no chunk exceeds maxChars.
      const pieces =
        s.text.length > this.maxChars ? hardSplit(s.text, this.maxChars) : [s.text];
      for (const piece of pieces) {
        const found = text.indexOf(piece, searchFrom);
        const start = found >= 0 ? found : searchFrom;
        searchFrom = start + piece.length;
        if (winEnd - winStart + (start + piece.length - winEnd) > this.maxChars && winEnd > winStart) {
          windows.push({ start: winStart, end: winEnd });
          winStart = Math.max(winStart, winEnd - this.overlapChars);
          winStart = backToSentenceStart(text, winStart);
        }
        if (winEnd === winStart) winStart = start;
        winEnd = Math.max(winEnd, start + piece.length);
      }
    }
    if (winEnd > winStart) windows.push({ start: winStart, end: winEnd });

    return windows
      .map((w) => ({
        text: text.slice(w.start, w.end).trim(),
        charStart: w.start,
        charEnd: w.end,
      }))
      .filter((c) => c.text.length > 0);
  }
}

export interface MarkdownChunkerOptions extends FixedWindowChunkerOptions {
  /** Max section size before a section is windowed further. Default 4000. */
  maxSectionChars?: number;
}

/**
 * Markdown-aware chunker.
 *
 * Splits on ATX headings (`#`..`######`) so each chunk keeps its section
 * heading for context; oversized sections fall back to FixedWindowChunker.
 * Content before the first heading becomes an untitled section.
 */
export class MarkdownSectionChunker implements Chunker {
  readonly name = 'markdown-section';
  private readonly window: FixedWindowChunker;
  private readonly maxSectionChars: number;

  constructor(options: MarkdownChunkerOptions = {}) {
    this.window = new FixedWindowChunker(options);
    this.maxSectionChars = options.maxSectionChars ?? 4000;
  }

  chunk(text: string): TextChunk[] {
    const sections = splitMarkdownSections(text);
    const out: TextChunk[] = [];
    for (const section of sections) {
      if (section.text.length <= this.maxSectionChars) {
        const trimmed = section.text.trim();
        if (trimmed.length > 0) {
          const chunk: TextChunk = {
            text: trimmed,
            charStart: section.start,
            charEnd: section.start + section.text.length,
          };
          if (section.heading !== undefined) chunk.heading = section.heading;
          out.push(chunk);
        }
        continue;
      }
      for (const w of this.window.chunk(section.text)) {
        const chunk: TextChunk = {
          text: w.text,
          charStart: section.start + w.charStart,
          charEnd: section.start + w.charEnd,
        };
        if (section.heading !== undefined) chunk.heading = section.heading;
        out.push(chunk);
      }
    }
    return out;
  }
}

interface Sentence {
  text: string;
  start: number;
}

/** Split text into sentences on `.`/`!`/`?`/newline boundaries, keeping offsets. */
function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  // Split after sentence-ending punctuation or on blank lines; keep offsets.
  const re = /[^.!?\n]+[.!?]+["'”’)]*|\n{2,}|[^\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const piece = m[0];
    if (/^\s*$/.test(piece)) continue;
    const start = m.index + (piece.length - piece.trimStart().length);
    const trimmed = piece.trim();
    if (trimmed.length > 0) out.push({ text: trimmed, start });
  }
  // Fallback: if the regex found nothing (e.g. CJK text), treat whole as one.
  if (out.length === 0 && text.trim().length > 0) {
    out.push({ text: text.trim(), start: text.indexOf(text.trim()) });
  }
  return out;
}

/** Hard-split a long string into pieces of at most `size` chars at word boundaries. */
function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size);
    if (cut <= 0) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Move an overlap start back to the nearest sentence start to avoid mid-sentence cuts. */
function backToSentenceStart(text: string, pos: number): number {
  if (pos <= 0) return 0;
  const slice = text.slice(0, pos);
  const idx = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '), slice.lastIndexOf('\n'));
  return idx >= 0 ? idx + 2 : pos;
}

interface MarkdownSection {
  heading?: string;
  text: string;
  start: number;
}

function splitMarkdownSections(text: string): MarkdownSection[] {
  const lines = text.split('\n');
  const sections: MarkdownSection[] = [];
  let current: string[] = [];
  let currentStart = 0;
  let currentHeading: string | undefined;
  let offset = 0;

  const flush = () => {
    const body = current.join('\n');
    if (body.trim().length > 0 || currentHeading !== undefined) {
      const section: MarkdownSection = { text: body, start: currentStart };
      if (currentHeading !== undefined) section.heading = currentHeading;
      sections.push(section);
    }
    current = [];
    currentHeading = undefined;
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      flush();
      currentStart = offset;
      currentHeading = headingMatch[2] as string;
      current.push(line);
    } else {
      if (current.length === 0 && currentHeading === undefined) currentStart = offset;
      current.push(line);
    }
    offset += line.length + 1;
  }
  flush();
  return sections;
}
