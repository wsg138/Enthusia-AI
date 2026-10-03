/**
 * @enthusia/source-provenance — source registry and provenance for Enthusia AI.
 *
 * The canonical model for where facts came from.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 17, 30, 50, 54;
 * MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md §§2.1, 4, 10.
 *
 * Quick start:
 *
 * ```ts
 * import {
 *   SourceProvenanceStore,
 *   SourceRegistry,
 *   buildLocator,
 * } from '@enthusia/source-provenance';
 * import { SourceType, Visibility } from '@enthusia/contracts';
 *
 * const registry = new SourceRegistry(
 *   new SourceProvenanceStore({ path: './data/source-provenance.sqlite' }),
 * );
 *
 * const locator = buildLocator(SourceType.GITHUB, 'wsg138/EnthusiaStaff', 'config.yml');
 * const result = registry.register({
 *   sourceType: SourceType.GITHUB,
 *   sourceLocator: locator,
 *   component: 'knowledge-indexer',
 *   authority: 'github:wsg138/EnthusiaStaff',
 *   version: '<commit-sha>', // any fingerprint: SHA, file hash, doc version
 *   visibility: Visibility.STAFF,
 * });
 * // result.outcome: 'CREATED' | 'UNCHANGED' | 'SUPERSEDED'
 * ```
 *
 * Storage is SQLite (better-sqlite3) for the MVP. Per spec §9.4 the
 * production direction is MySQL/MariaDB; the schema uses portable
 * constructs (TEXT ISO-8601 timestamps, versioned migrations) so the port
 * is mechanical. See README.md.
 */

export * from './errors.js';
export * from './version.js';
export * from './visibility.js';
export * from './authority.js';
export * from './lifecycle.js';
export * from './locator.js';
export * from './store.js';
export * from './registry.js';
