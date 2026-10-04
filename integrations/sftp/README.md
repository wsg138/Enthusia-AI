# @enthusia/integration-sftp — SFTP/server file indexer (W09)

Builds read-only knowledge from approved server files. Part of the Enthusia AI
knowledge/indexing service (MASTER-SPECIFICATION.md §§12, 24).

## What it owns

- **Allowlisted server roots** (`src/config.ts`) — per-server roots such as
  `plugins/`, plugin configs, and selected logs. Nothing outside these roots
  is ever listed or read.
- **Read-only SFTP client** (`src/sftp-client.ts`) — `ssh2`-based, SFTP
  subsystem only. `exec`/`shell` are not representable in the `SftpClient`
  interface, so there is no code path that runs commands on the server.
- **File metadata** — path, size, mtime, sha256 (`src/parsers.ts`,
  `src/indexer.ts`).
- **Incremental parsing** — fast path skips files whose (size, mtime) match
  the indexed artifact; slow path re-hashes and skips identical content.
  Changed files are re-registered (W04 atomic supersession) and re-chunked
  into W07 with status propagation. Deleted files are marked INVALID.
- **Secret deny patterns** (`src/deny.ts`) — HARD DENY, enforced in code on
  every read path via `DenyGuardSftpClient`:
  `.env` files, `*credential*`, `*secret*`, `*.pem`/`*.key`, `id_rsa*`,
  `id_ed25519*`, `*token*`, plus `.ssh/` directories. Content that looks
  like a private key is refused even when the path passed the deny check.
- **Reconciliation scheduling** (`src/reconciler.ts`) — periodic scans per
  §12.3: single-flight, jittered, fail-soft, with health state for §36.

## Security model

- Credentials are **never** in config: `authSource` + `authRef` only name
  *where* the tool layer resolves key material from. Config schemas are
  strict — unknown keys (e.g. a smuggled `password`) fail loudly.
- The deny set is unconditional and cannot be disabled by configuration.
- `Visibility.SECRET_DENY` artifacts are refused by the retrieval port.

## Wiring

```ts
import { compileConfig } from '@enthusia/integration-sftp';
import { SftpIndexer } from '@enthusia/integration-sftp';
import { SftpReconciler } from '@enthusia/integration-sftp';

const compiled = compileConfig(rawConfig); // throws on unknown keys / bad paths
const reconciler = new SftpReconciler(
  compiled,
  async (serverId) => connectSftp({ serverId, host, port, readyTimeoutMs, credentials: resolveFromToolLayer }),
  () => ({ registry: new SourceRegistry(store), retrieval: new KnowledgeRetrievalEngine(deps) }),
  { intervalMs: compiled.config.reconcileIntervalMs, jitterMs: compiled.config.reconcileJitterMs },
);
reconciler.start();
```

The `ArtifactRegistryPort` / `RetrievalEnginePort` interfaces in `src/ports.ts`
mirror the W04 `SourceRegistry` and W07 `KnowledgeRetrievalEngine` APIs
exactly, so the real implementations satisfy them structurally with no
adapter and no modification to W04/W07 code.

## Tests

`npm run test` — 77 tests with an in-memory mock SFTP server (`test/fakes.ts`);
no real connections, no production servers, no credentials. Deny patterns are
tested rigorously, including traversal bypasses and the guard on every client
operation.
