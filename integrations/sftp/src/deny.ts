/**
 * @enthusia/integration-sftp — secret deny enforcement (W09).
 *
 * HARD SECURITY BOUNDARY. These patterns are enforced IN CODE on every
 * read path — listing, stat, read, and hash — through `DenyGuardSftpClient`
 * and `assertAllowedPath`. They must never depend on prompt instructions,
 * model cooperation, or configuration.
 *
 * Spec: MASTER-SPECIFICATION.md §17.6 (SECRET_DENY), §24.1;
 * WORKER-EXECUTION-PLAN.md §12 (W09 "Hard deny").
 *
 * Matching rules (all case-insensitive, applied to POSIX-normalized paths):
 *   - `.env` files: any path segment that is exactly `.env`, or a basename
 *     of the form `.env.<suffix>` (`.env.local`, `.env.example`, ...).
 *   - `*credential*`: the substring "credential" anywhere in the path.
 *   - `*secret*`: the substring "secret" anywhere in the path.
 *   - `*.pem`, `*.key`: path ends with `.pem` or `.key`.
 *   - `id_rsa*`, `id_ed25519*`: a path segment whose basename starts with
 *     `id_rsa` or `id_ed25519` (private/public key pairs and derivatives).
 *   - `*token*`: the substring "token" anywhere in the path.
 *   - `.ssh` directories (hardening beyond the listed patterns: an SSH
 *     directory can only ever contain keys and known_hosts, neither of
 *     which is indexable knowledge).
 *
 * Additional operator-supplied patterns can be layered on via
 * `compileExtraDenyPatterns` (config), but the built-in set below is
 * unconditional and cannot be disabled.
 */

import posixPath from 'node:path/posix';

/** A single named deny rule: predicate over a normalized absolute path. */
export interface DenyRule {
  /** Human-readable rule name used in denial messages and tests. */
  name: string;
  /** Returns true when the path must never be read or indexed. */
  matches: (normalizedPath: string) => boolean;
}

const ci = (pattern: RegExp): RegExp => new RegExp(pattern.source, 'i');

export const HARD_DENY_RULES: readonly DenyRule[] = [
  {
    name: 'env-file',
    matches: (p) => ci(/(^|\/)\.env(\.|$)/).test(p),
  },
  {
    name: 'credential',
    matches: (p) => p.toLowerCase().includes('credential'),
  },
  {
    name: 'secret',
    matches: (p) => p.toLowerCase().includes('secret'),
  },
  {
    name: 'pem-key-file',
    matches: (p) => ci(/\.(pem|key)$/).test(p),
  },
  {
    name: 'ssh-private-key-name',
    matches: (p) => ci(/(^|\/)id_(rsa|ed25519)/).test(p),
  },
  {
    name: 'token',
    matches: (p) => p.toLowerCase().includes('token'),
  },
  {
    name: 'ssh-directory',
    matches: (p) => ci(/(^|\/)\.ssh(\/|$)/).test(p),
  },
];

/**
 * Normalize a remote path for deny matching: collapse `.`/`..`/duplicate
 * slashes, force a leading slash, and lowercase nothing (matching itself is
 * case-insensitive). Normalization matters: `plugins/../.env` must match.
 */
export function normalizeForDenyCheck(remotePath: string): string {
  const normalized = posixPath.normalize(remotePath.replace(/\\/g, '/'));
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/** The rule that denied this path, or undefined when the path is allowed. */
export function denyRuleFor(
  remotePath: string,
  extraRules: readonly DenyRule[] = [],
): DenyRule | undefined {
  const normalized = normalizeForDenyCheck(remotePath);
  for (const rule of HARD_DENY_RULES) {
    if (rule.matches(normalized)) return rule;
  }
  for (const rule of extraRules) {
    if (rule.matches(normalized)) return rule;
  }
  return undefined;
}

/** True when the path must never be read or indexed. */
export function isDeniedPath(remotePath: string, extraRules: readonly DenyRule[] = []): boolean {
  return denyRuleFor(remotePath, extraRules) !== undefined;
}

/**
 * Error thrown the moment any code path touches a denied path.
 * Carries the path (paths are not secrets; the matched rule name is logged
 * for audit) — but NEVER any file content.
 */
export class SecretDenyError extends Error {
  readonly deniedPath: string;
  readonly ruleName: string;

  constructor(deniedPath: string, ruleName: string) {
    super(`secret-deny: refusing to access "${deniedPath}" (rule: ${ruleName})`);
    this.name = 'SecretDenyError';
    this.deniedPath = deniedPath;
    this.ruleName = ruleName;
  }
}

/**
 * Throw SecretDenyError when the path is denied; otherwise return the
 * normalized path. Call this at the TOP of every read/list/stat/hash
 * operation — no exceptions.
 */
export function assertAllowedPath(
  remotePath: string,
  extraRules: readonly DenyRule[] = [],
): string {
  const normalized = normalizeForDenyCheck(remotePath);
  const rule = denyRuleFor(normalized, extraRules);
  if (rule !== undefined) {
    throw new SecretDenyError(normalized, rule.name);
  }
  return normalized;
}

/**
 * Compile operator-supplied extra deny patterns (plain substrings or
 * `/regex/` strings) into DenyRules. Invalid regexes are rejected at
 * config-load time, not at scan time.
 */
export function compileExtraDenyPatterns(patterns: readonly string[]): DenyRule[] {
  return patterns.map((pattern, i) => {
    let regex: RegExp;
    const asRegex = /^\/(.+)\/([a-z]*)$/.exec(pattern);
    try {
      if (asRegex !== null) {
        const body: string = asRegex[1] as string;
        const flags: string = asRegex[2] as string;
        regex = new RegExp(body, flags.includes('i') ? 'i' : '');
      } else {
        regex = new RegExp(pattern, 'i');
      }
    } catch (cause) {
      throw new Error(`invalid extra deny pattern #${i} "${pattern}": ${(cause as Error).message}`);
    }
    return {
      name: `extra-deny-${i}`,
      matches: (p) => regex.test(p),
    } satisfies DenyRule;
  });
}
