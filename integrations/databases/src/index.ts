/**
 * @enthusia/integration-databases — read-only database safe tools (W10).
 *
 * Spec: MASTER-SPECIFICATION.md §§16.1, 25; WORKER-EXECUTION-PLAN.md §13.
 *
 * Exposes current live database facts without giving the model arbitrary
 * database power:
 * - read-only connection management (config.ts, connection.ts, client.ts);
 * - purpose-built query functions, NOT arbitrary SQL (tools.ts on top of the
 *   closed template registry in query-templates.ts);
 * - schema descriptions (schema.ts);
 * - result provenance on every result (provenance.ts);
 * - timeout/row limits (connection.ts, client.ts).
 *
 * The five tools implement the W12 Tool interface shape (tool-adapter.ts) and
 * plug into W12's ToolRegistry. No real database connections are made by this
 * package: deployments inject a DbClientFactory backed by a read-only
 * account; tests use MockReadOnlyDbClient.
 */
export * from './config.js';
export * from './query-templates.js';
export * from './client.js';
export * from './connection.js';
export * from './schema.js';
export * from './provenance.js';
export * from './tool-adapter.js';
export * from './tools.js';
