/**
 * @enthusia/integration-sftp — file content preparation (W09).
 *
 * Decides whether a file's bytes are safe and useful to index, and produces
 * the normalized text given to W07 for chunking. Defense in depth alongside
 * the path-based deny set:
 *
 * - Binary files are skipped (indexing a .jar buys nothing for support QA).
 * - Content that looks like secret material (PEM private-key blocks) is
 *   refused even when the path itself passed the deny check — a key saved
 *   as `notes.txt` must still never reach model-visible storage (§17.6).
 * - Oversized files are skipped, never truncated-and-indexed (a truncated
 *   config would produce confidently wrong "current facts").
 *
 * The parser version is stamped on every artifact so parser changes can
 * trigger deliberate re-indexing later.
 */

export const PARSER_VERSION = 'sftp-w09/1.0.0';

/** PEM/OpenSSH private-key markers: never index content containing these. */
const SECRET_CONTENT_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /-----BEGIN ENCRYPTED PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** Heuristic: NUL bytes in the first 8 KiB => binary. */
export function isProbablyBinary(content: Buffer): boolean {
  const sample = content.subarray(0, 8192);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

/**
 * True when decoded text contains secret material (private keys).
 * Scans only the first 64 KiB — keys announce themselves in their header.
 */
export function containsSecretMaterial(text: string): boolean {
  const head = text.slice(0, 65_536);
  return SECRET_CONTENT_PATTERNS.some((re) => re.test(head));
}

export type PrepareOutcome =
  | { ok: true; text: string }
  | { ok: false; skippedReason: 'binary' | 'oversized' | 'secret-content' | 'empty' | 'decode-error' };

/**
 * Prepare file bytes for indexing. `maxBytes` is the same cap used for the
 * bounded read: anything that arrived larger was already rejected.
 */
export function prepareDocumentText(content: Buffer, maxBytes: number): PrepareOutcome {
  if (content.length === 0) return { ok: false, skippedReason: 'empty' };
  if (content.length > maxBytes) return { ok: false, skippedReason: 'oversized' };
  if (isProbablyBinary(content)) return { ok: false, skippedReason: 'binary' };
  let text: string;
  try {
    text = content.toString('utf8');
  } catch {
    return { ok: false, skippedReason: 'decode-error' };
  }
  if (containsSecretMaterial(text)) return { ok: false, skippedReason: 'secret-content' };
  // Normalize: strip trailing whitespace per line, collapse >2 blank lines,
  // drop the UTF-8 BOM. Keep the file's informational content intact.
  const normalized = text
    .replace(/^﻿/, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (normalized.length === 0) return { ok: false, skippedReason: 'empty' };
  return { ok: true, text: normalized };
}

/**
 * Content metadata stored on the artifact (W04 `contentMetadata`): the
 * (size, mtime) pair lets the indexer skip unchanged files without reading
 * them at all; `sha256` is the version fingerprint (§12.2).
 */
export interface SftpFileFingerprint {
  sha256: string;
  size: number;
  mtimeMs: number;
}

export function fingerprintToVersion(fingerprint: SftpFileFingerprint): string {
  return `sha256:${fingerprint.sha256}`;
}
