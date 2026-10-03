/**
 * @enthusia/source-provenance — canonical source locators.
 *
 * A locator is the *identity* of a source: the key the registry uses to
 * decide which artifact is CURRENT for that source. It must be
 * version-independent — the version/hash lives on the artifact, never in
 * the locator — so that re-registering the same source with a new version
 * supersedes the old artifact instead of creating an unrelated one.
 *
 * Canonical forms (scheme : identity):
 * - GITHUB:         github:<owner>/<repo>:<path>
 * - SFTP_FILE:      sftp:<service>:<absolute-path>
 * - DOCUMENT:       document:<collection>:<doc-id>
 * - CONFIG:         config:<server>:<name>
 * - DATABASE_SCHEMA: dbschema:<database>[:<table>]
 * - DATABASE_LIVE:  dblive:<database>:<view-or-table>[:<key>]
 * - DISCORD:        discord:<guild-id>:<channel-id>[:<message-id>]
 * - TICKET:        ticket:<system>:<ticket-id>
 * - STAFF:          staff:<staff-id>:<entry-id>
 * - DEPLOYMENT:     deployment:<component>:<target-server>
 * - GENERATED:      generated:<component>:<name>
 */

import { SourceType } from '@enthusia/contracts';
import { InvalidLocatorError } from './errors.js';

const SCHEME_BY_SOURCE_TYPE: Record<SourceType, string> = {
  [SourceType.GITHUB]: 'github',
  [SourceType.SFTP_FILE]: 'sftp',
  [SourceType.DOCUMENT]: 'document',
  [SourceType.CONFIG]: 'config',
  [SourceType.DATABASE_SCHEMA]: 'dbschema',
  [SourceType.DATABASE_LIVE]: 'dblive',
  [SourceType.DISCORD]: 'discord',
  [SourceType.TICKET]: 'ticket',
  [SourceType.STAFF]: 'staff',
  [SourceType.DEPLOYMENT]: 'deployment',
  [SourceType.GENERATED]: 'generated',
};

const SOURCE_TYPE_BY_SCHEME: Record<string, SourceType> = Object.fromEntries(
  Object.entries(SCHEME_BY_SOURCE_TYPE).map(([type, scheme]) => [scheme, type as SourceType]),
);

export interface ParsedLocator {
  sourceType: SourceType;
  scheme: string;
  /** Everything after `scheme:`. The stable identity of the source. */
  identity: string;
  /** The original locator string. */
  locator: string;
}

/**
 * Build a canonical locator for `sourceType` from identity parts.
 * Parts are joined with ':'; empty parts are rejected.
 */
export function buildLocator(sourceType: SourceType, ...parts: string[]): string {
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new InvalidLocatorError(parts.join(':'), 'locator needs at least one non-empty identity part');
  }
  if (parts.some((p) => p.includes(':'))) {
    throw new InvalidLocatorError(
      parts.join(':'),
      'identity parts must not contain ":" (use "-" or "/" instead)',
    );
  }
  return `${SCHEME_BY_SOURCE_TYPE[sourceType]}:${parts.join(':')}`;
}

/** Parse and validate a locator. Throws InvalidLocatorError on any problem. */
export function parseLocator(locator: string): ParsedLocator {
  const trimmed = locator.trim();
  const colon = trimmed.indexOf(':');
  if (colon <= 0) {
    throw new InvalidLocatorError(locator, 'expected "<scheme>:<identity>"');
  }
  const scheme = trimmed.slice(0, colon).toLowerCase();
  const sourceType = SOURCE_TYPE_BY_SCHEME[scheme];
  if (sourceType === undefined) {
    throw new InvalidLocatorError(locator, `unknown scheme ${JSON.stringify(scheme)}`);
  }
  const identity = trimmed.slice(colon + 1);
  if (identity.length === 0) {
    throw new InvalidLocatorError(locator, 'identity part is empty');
  }
  return { sourceType, scheme, identity, locator: trimmed };
}

/**
 * Validate that `locator` parses and that its scheme matches `sourceType`.
 * Returns the parsed locator.
 */
export function assertLocatorMatchesType(locator: string, sourceType: SourceType): ParsedLocator {
  const parsed = parseLocator(locator);
  if (parsed.sourceType !== sourceType) {
    throw new InvalidLocatorError(
      locator,
      `scheme ${JSON.stringify(parsed.scheme)} does not match source type ${sourceType}`,
    );
  }
  return parsed;
}
