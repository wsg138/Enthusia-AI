/**
 * Safe file preparation for SFTP indexing and live reads.
 *
 * Binary and oversized files are never indexed. Structured credential fields
 * are redacted before model-visible storage; opaque private keys/tokens that
 * remain after redaction deny the entire file.
 */

import {
  containsHighRiskSecretMaterial,
  sanitizeModelVisibleText,
} from './redaction.js';

export const PARSER_VERSION = 'sftp-live/2.0.0';

const SECRET_CONTENT_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /-----BEGIN ENCRYPTED PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|passphrase|token|api[_-]?key|client[_-]?secret|forwarding[_-]?secret|shared[_-]?secret)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

export function isProbablyBinary(content: Buffer): boolean {
  const sample = content.subarray(0, 8192);
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] === 0) return true;
  }
  return false;
}

/**
 * Broad detector retained for callers/tests that want to classify raw text.
 * prepareDocumentText uses field-aware redaction first instead.
 */
export function containsSecretMaterial(text: string): boolean {
  const head = text.slice(0, 65_536);
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(head));
}

export type PrepareOutcome =
  | {
      ok: true;
      text: string;
      redactedFields: string[];
      redactionCount: number;
    }
  | {
      ok: false;
      skippedReason:
        | 'binary'
        | 'oversized'
        | 'secret-content'
        | 'empty'
        | 'decode-error';
    };

export function prepareDocumentText(
  content: Buffer,
  maxBytes: number,
  filePath = '',
): PrepareOutcome {
  if (content.length === 0) return { ok: false, skippedReason: 'empty' };
  if (content.length > maxBytes) return { ok: false, skippedReason: 'oversized' };
  if (isProbablyBinary(content)) return { ok: false, skippedReason: 'binary' };

  let text: string;
  try {
    text = content.toString('utf8');
  } catch {
    return { ok: false, skippedReason: 'decode-error' };
  }

  const sanitized = sanitizeModelVisibleText(text, filePath);
  if (!sanitized.ok || containsHighRiskSecretMaterial(sanitized.text)) {
    return { ok: false, skippedReason: 'secret-content' };
  }
  if (sanitized.text.length === 0) return { ok: false, skippedReason: 'empty' };
  return sanitized;
}

export interface SftpFileFingerprint {
  sha256: string;
  size: number;
  mtimeMs: number;
}

export function fingerprintToVersion(fingerprint: SftpFileFingerprint): string {
  return 'sha256:' + fingerprint.sha256;
}
