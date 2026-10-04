/**
 * @enthusia/integration-github — GitHub repository indexer (W08).
 *
 * Incremental indexing of approved GitHub repositories into the knowledge
 * system: repository registry, Git Data API ingestion (no clones), SHA
 * tracking, per-file incremental re-indexing with atomic supersession,
 * source/docs/issues-PR parsing, regex code-symbol extraction, and
 * derived entity relationships (repo -> plugin -> commands -> permissions).
 *
 * Integration wiring (NOT done here — composition happens once W04/W07
 * merge into the base branch):
 *
 *   import { SourceRegistry } from '@enthusia/source-provenance'; // W04
 *   import { KnowledgeRetrievalEngine } from '@enthusia/knowledge-indexer'; // W07
 *   const indexer = new GitHubIndexer(config, {
 *     client: new RestGitHubClient({ token, userAgent }),
 *     registry: new SourceRegistry(store),
 *     retrieval: new KnowledgeRetrievalEngine(deps),
 *   });
 *
 * The real W04/W07 classes satisfy the ports in `ports.ts` structurally,
 * so no adapter is needed.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 23; WORKER-EXECUTION-PLAN.md §11.
 */

export { GitHubIndexer, createGitHubIndexer } from './indexer.js';
export {
  DEPLOYMENT_STATE_GIT_MAIN,
  GITHUB_INDEXER_COMPONENT,
  GITHUB_INDEXER_PARSER_VERSION,
} from './indexer.js';
export type {
  IndexerDeps,
  RepoIndexReport,
  SkippedFile,
} from './indexer.js';

export {
  loadGitHubIndexerConfig,
  repoIdentity,
} from './config.js';
export type {
  ApprovedRepo,
  GitHubIndexerConfig,
  GitHubIndexerConfigInput,
  ResolvedApprovedRepo,
} from './config.js';

export { RestGitHubClient, GitHubApiError } from './github-client.js';
export type {
  GitBlob,
  GitHubApi,
  GitHubDiscussion,
  GitHubRepoMeta,
  GitTreeEntry,
} from './github-client.js';

export {
  classifyPath,
  extractSymbols,
  languageForPath,
  looksLikeSecret,
  looksBinary,
  parseFile,
  parseManifest,
  parseSimpleYaml,
  renderManifestText,
} from './parsers.js';
export type {
  CodeSymbol,
  FileKind,
  ParsedFile,
  ParseOptions,
  ParseResult,
  PluginCommand,
  PluginManifest,
  PluginPermission,
  SkipDecision,
  SkipReason,
  SymbolLanguage,
} from './parsers.js';

export {
  commandEntityId,
  fileEntityId,
  permissionEntityId,
  pluginEntityId,
  relationshipsForManifest,
  renderRelationshipsText,
  repoEntityId,
} from './relationships.js';
export type { EntityRelationship, RelationshipType } from './relationships.js';

export type {
  ArtifactRegistryPort,
  IndexedChunk,
  RegisterArtifactInput,
  RegisterOutcome,
  RegisterResult,
  RetrievalEnginePort,
  StoredArtifact,
  TextChunkCut,
  TextChunker,
} from './ports.js';
