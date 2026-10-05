# Live read-only server source — owner setup

This document is the deployment gate for the live server source added by issue
#29. The Live Plugin Intelligence Audit remains blocked until this layer is
reviewed and the owner completes a credential/configuration setup that follows
this contract.

## 1. Create a dedicated read-only SFTP identity

For each target server, use a dedicated account whose operating-system
permissions allow reads only for the specific server tree needed by Enthusia
AI. Do not reuse a deployment account, panel administrator credential, or any
identity that can edit, delete, chmod, restart, or deploy.

Preferred SSH restrictions:

- SFTP subsystem only; no interactive shell and no remote command execution.
- Public-key authentication where practical.
- Filesystem ACLs or ownership that make approved roots read-only to the AI
  account.
- No access to home directories, SSH material, environment files, backups, or
  credential stores unless a separately reviewed source is explicitly needed.
- Network access restricted to the Bloom/runtime host where practical.

The application interface itself only represents list, realpath, stat, bounded
read, hash, and close. OS-level read-only permissions are still required as a
second boundary.

## 2. Pin the SSH host key

Any server with a liveSource section must provide hostKeySha256. Obtain the
expected SHA-256 fingerprint from the server through an owner-trusted channel,
then compare it with the fingerprint presented by SSH before adding it to
configuration.

Example placeholder:

    hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

Do not copy an unverified fingerprint from an unexpected connection prompt.

## 3. Store credentials outside repository/configuration

The checked configuration contains only:

- authSource: env or secret-manager
- authRef: the runtime lookup name

The value referenced by authRef must be injected only into the Enthusia AI
gateway/runtime. It must not be written into:

- repository files;
- model prompts or tool schemas;
- normal logs;
- source-index documents;
- embeddings;
- memory;
- training datasets.

The runtime resolver returns only private key/passphrase/password material to
the SFTP connection factory. The live gateway never returns host, username,
authRef, or credential material in model-visible results.

## 4. Configure named sources, not arbitrary paths

Example only; all values are placeholders:

    servers:
      - id: smp
        host: "smp-sftp.example.invalid"
        port: 22
        username: "enthusia-ai-readonly"
        readyTimeoutMs: 10000
        authSource: "env"
        authRef: "ENTHUSIA_AI_SMP_SFTP"
        hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        roots:
          - path: "/srv/minecraft/smp"
            visibility: "STAFF"
            extraDenyPatterns:
              - "/backups/"
        liveSource:
          displayName: "SMP"
          environment: "production"
          operationTimeoutMs: 10000
          maxJarBytes: 67108864
          maxConfigBytes: 1048576
          maxMetadataBytes: 524288
          maxResults: 200
          pluginDirectories:
            - id: "plugins"
              path: "/srv/minecraft/smp/plugins"
              visibility: "STAFF"
          configDirectories:
            - id: "plugin-configs"
              path: "/srv/minecraft/smp/plugins"
              visibility: "STAFF"
              includeExtensions: [".yml", ".yaml", ".json", ".properties"]
              maxDepth: 4
          approvedFiles:
            - id: "server-properties"
              path: "/srv/minecraft/smp/server.properties"
              kind: "server-properties"
              format: "properties"
              visibility: "STAFF"
            - id: "deployment-identity"
              path: "/srv/minecraft/smp/deployment.properties"
              kind: "deployment-identity"
              format: "properties"
              visibility: "STAFF"

Every live-source path must be inside an allowlisted roots entry and must
pass the unconditional secret-deny rules. Source IDs are the only selectors
accepted by approved-file reads. Plugin inspection additionally accepts one
basename ending in .jar; slashes, backslashes, NUL, and traversal names are
rejected before SFTP access.

## 5. Deployment identity marker, if available

A deployment marker is optional but recommended because Git state and
production state are different facts. If the deployment process already
writes a read-only marker, approve that existing marker rather than inventing
a second source of truth.

The gateway only publishes these allowlisted identity fields when present:

- deploymentId
- runtimeVersion
- gitSha
- buildId
- deployedAt

Other fields are ignored. Credential-looking fields are redacted before the
marker is parsed.

Do not claim a Git SHA is deployed merely because it is current on main.
Plugin inspection keeps these identities separate:

- Git source SHA found in safe JAR metadata, if available;
- build artifact identity;
- deployed file identity/hash on a target server;
- target server identity;
- runtime/deployment marker identity, when separately available.

## 6. Credential resolver wiring

The production composition layer should call
createConfiguredSftpClientFactory(compiledConfig, resolver) and inject the
returned factory into LiveServerSourceGateway.

The resolver must:

1. accept serverId, authSource, and authRef;
2. fetch the secret only inside the runtime;
3. return private-key/passphrase/password material;
4. never log the returned material;
5. fail closed when the reference is missing;
6. avoid placing the secret into exceptions.

createConfiguredSftpClientFactory adds the configured username and SSH host-key
pin and opens only the SFTP subsystem.

## 7. Pre-authorization checks

Before authorizing a real connection, review all of the following:

- branch/PR for issue #29 is approved;
- hosted CI and static analysis are clean;
- each target has a dedicated read-only identity;
- each host key is independently verified and pinned;
- every root/source path is reviewed;
- broad roots are narrowed where practical;
- credential files remain denied;
- config visibility is correct;
- timeout/size limits are acceptable for the SMP host;
- no production write capability is granted by OS permissions;
- no real credential has been committed to the repository.

Then run a deliberately small owner-authorized smoke against one target before
adding more servers.

## 8. Rollback / emergency stop

No live source is required for SMP, Ticket Bot, moderation, Discord adapter,
or the agent gateway to remain alive. To disable this source without mutating a
server:

1. remove/disable the runtime wiring that constructs the live-source gateway,
   or remove the server's liveSource configuration;
2. revoke the dedicated read-only credential if compromise is suspected;
3. keep other Enthusia AI services running;
4. mark any source-derived current knowledge stale until live verification is
   restored.

Do not use this gateway to restart, reload, edit, delete, chmod, or deploy.
Those operations are intentionally absent.
