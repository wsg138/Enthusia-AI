# @enthusia/integration-sftp — read-only server source

This package owns the read-only server/SFTP source boundary used by Enthusia
AI. It contains the original W09 incremental indexer plus the issue #29 live
CURRENT-TRUTH gateway.

## Security boundary

- SFTP only. The client interface represents list, realpath, stat, bounded
  read, hash, and close. It has no exec, shell, write, rename, delete, chmod,
  restart, reload, or deploy operation.
- Every filesystem operation is confined to an allowlisted root twice:
  lexically and after server-side realpath resolution. Symlink escapes fail.
- Live sources are configured by stable IDs. Approved-file reads do not accept
  a caller-supplied path. Plugin inspection accepts only a single .jar
  basename inside a configured plugin directory.
- Credential material is resolved only by the runtime credential resolver.
  Host, username, authRef, and credentials are not part of model-visible live
  results.
- Any server enabling liveSource must pin an SSH SHA-256 host-key fingerprint.
- Hard-denied paths include environment files, credentials/secrets/tokens,
  SSH directories and private keys. The deny set cannot be disabled by
  configuration.
- Otherwise useful structured configuration is secret-aware: password, token,
  API-key, private-key, forwarding/shared secret, database connection, and
  similar fields are replaced with [REDACTED] before indexing or live output.
  Opaque high-risk secret material that remains after redaction denies the
  entire file.
- Reads are bounded by separate JAR/config/metadata byte caps and an operation
  deadline. Cancellation is supported through AbortSignal.
- Connection/source failure returns a safe failure result and does not throw
  transport details into model-visible output.

## W09 incremental indexing

SftpIndexer walks configured roots and records:

- server identity;
- path;
- size;
- mtime;
- SHA-256 version;
- visibility;
- parser version.

Changed files supersede prior source artifacts; deleted files become INVALID.
An incomplete scan marks affected current knowledge STALE until it can be
verified again. The indexer now applies the same secret-aware sanitization as
live reads before any text reaches retrieval/embeddings.

SftpReconciler remains single-flight, jittered, and fail-soft. One unreachable
server does not terminate its scheduler or unrelated services.

## Live CURRENT-TRUTH operations

LiveServerSourceGateway exposes only typed reads:

- listServers()
- listPlugins(serverId, directoryId)
- inspectPlugin(serverId, directoryId, jarFileName)
- discoverConfigs(serverId, directoryId)
- readApprovedFile(serverId, sourceId)

Plugin inspection safely reads JAR ZIP metadata only; it never loads classes.
Supported descriptors include plugin.yml, paper-plugin.yml, and
velocity-plugin.json. Results can include:

- plugin name/version/main class;
- declared dependencies and soft dependencies;
- commands;
- permissions;
- JAR filename, SHA-256, size, and mtime;
- safe build metadata;
- Git source SHA found in JAR metadata, if present.

The result deliberately keeps these concepts separate:

1. Git source SHA — source revision claimed by safe JAR metadata;
2. build artifact — JAR filename/hash/size plus optional build fields;
3. deployed file — exact path/hash/size/mtime observed on the target;
4. target server — stable server identity;
5. runtime/deployment identity — explicit marker data when separately read
   from an approved deployment-identity source.

Git main is never inferred to equal deployed production.

## Configuration

compileConfig is strict. Unknown keys are rejected. Credential values do not
exist in the schema.

A liveSource section may configure:

- displayName/environment;
- operationTimeoutMs;
- maxJarBytes;
- maxConfigBytes;
- maxMetadataBytes;
- maxResults;
- named pluginDirectories;
- named configDirectories;
- named approvedFiles.

Every named path must be inside one of the server's roots and pass hard deny
rules during configuration compilation.

See LIVE-SOURCE-SETUP.md for the exact owner-side credential, host-key,
filesystem, wiring, review, and rollback steps. No production connection is
required for tests.

## Production wiring

Use createConfiguredSftpClientFactory with a runtime-only credential resolver,
then inject that factory into LiveServerSourceGateway. The factory applies the
configured target, username, ready timeout, and host-key pin and opens only
SFTP.

The original SftpReconciler may use the same factory for indexing when desired.

## Tests

The package uses an in-memory SFTP fixture. Coverage includes allowlisted
reads, hard deny, traversal, canonical/symlink escape, byte limits, timeout,
cancellation, unreachable sources, credential-field redaction,
credential-file denial, provenance, Git/deployed-version distinction,
malformed JAR/plugin metadata, multiple server identities, incremental
freshness, and the absence of live write operations.

No test requires a production credential or network connection.
