/**
 * Live server source security and provenance tests.
 *
 * All fixtures are in-memory. No network, production host, or real credential
 * is used by this suite.
 */

import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import { compileConfig } from '../src/config.js';
import { parsePluginJar } from '../src/jar-metadata.js';
import {
  LiveServerSourceGateway,
  type LiveSftpClientFactory,
} from '../src/live-source.js';
import { MockSftpServer } from './fakes.js';

const HOST_KEY = 'SHA256:' + 'A'.repeat(43);
const FIXED_NOW = new Date('2026-10-04T20:00:00.000Z');

function storedZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

function pluginJar(): Buffer {
  return storedZip({
    'plugin.yml': [
      'name: ExamplePlugin',
      'version: 2.0.0',
      'main: net.example.ExamplePlugin',
      'depend: [Vault]',
      'softdepend:',
      '  - PlaceholderAPI',
      'commands:',
      '  example:',
      '    description: Example command',
      'permissions:',
      '  example.use:',
      '    default: true',
      '',
    ].join('\n'),
    'META-INF/MANIFEST.MF': [
      'Manifest-Version: 1.0',
      'Implementation-Version: build-42',
      'Build-Number: 42',
      'Git-Commit: abcdef123456',
      '',
    ].join('\n'),
  });
}

function serverConfig(id: string, root: string, maxJarBytes = 1024 * 1024) {
  return {
    id,
    host: id + '.example.invalid',
    username: 'readonly-test-user',
    authRef: 'TEST_ONLY_' + id.toUpperCase() + '_SFTP',
    hostKeySha256: HOST_KEY,
    roots: [{ path: root, visibility: Visibility.STAFF }],
    liveSource: {
      displayName: id.toUpperCase(),
      environment: 'production',
      operationTimeoutMs: 100,
      maxJarBytes,
      maxConfigBytes: 4096,
      maxMetadataBytes: 4096,
      maxResults: 20,
      pluginDirectories: [
        { id: 'plugins', path: root + '/plugins', visibility: Visibility.STAFF },
      ],
      configDirectories: [
        {
          id: 'configs',
          path: root + '/plugins',
          visibility: Visibility.STAFF,
          includeExtensions: ['.yml', '.yaml', '.json', '.properties'],
          maxDepth: 3,
        },
      ],
      approvedFiles: [
        {
          id: 'server-properties',
          path: root + '/server.properties',
          kind: 'server-properties',
          format: 'properties',
          visibility: Visibility.STAFF,
        },
        {
          id: 'deployment',
          path: root + '/deployment.properties',
          kind: 'deployment-identity',
          format: 'properties',
          visibility: Visibility.STAFF,
        },
      ],
    },
  };
}

function makeServer(root = '/srv/smp'): MockSftpServer {
  const server = new MockSftpServer();
  server.writeFile(root + '/plugins/ExamplePlugin.jar', pluginJar(), 1_700_000_000_000);
  server.writeFile(root + '/plugins/ExamplePlugin/config.yml', 'feature: true\n', 1_700_000_000_100);
  server.writeFile(root + '/plugins/ExamplePlugin/token-cache.yml', 'token: TEST_ONLY\n', 1_700_000_000_200);
  server.writeFile(
    root + '/server.properties',
    [
      'motd=Welcome to Enthusia',
      'rcon.password=TEST_ONLY_SECRET_VALUE',
      'discord-token=TEST_ONLY_DISCORD_VALUE',
      'database.url=jdbc:mysql://test.invalid/db?password=TEST_ONLY',
      '',
    ].join('\n'),
    1_700_000_000_300,
  );
  server.writeFile(
    root + '/deployment.properties',
    [
      'deploymentId=release-2026-10-04',
      'runtimeVersion=2026.10.04.1',
      'gitSha=1234567abcdef',
      'buildId=4242',
      'deployedAt=2026-10-04T19:55:00Z',
      'apiToken=TEST_ONLY_VALUE',
      '',
    ].join('\n'),
    1_700_000_000_400,
  );
  return server;
}

function gatewayFor(
  servers: Record<string, MockSftpServer>,
  maxJarBytes = 1024 * 1024,
  factoryOverride?: LiveSftpClientFactory,
): LiveServerSourceGateway {
  const configs = Object.keys(servers).map((id) => {
    const root = id === 'proxy' ? '/srv/proxy' : '/srv/smp';
    return serverConfig(id, root, maxJarBytes);
  });
  const compiled = compileConfig({ servers: configs });
  const factory: LiveSftpClientFactory = factoryOverride ?? (async (serverId) => {
    const server = servers[serverId];
    if (server === undefined) throw new Error('simulated unreachable');
    return server;
  });
  return new LiveServerSourceGateway(compiled, factory, () => FIXED_NOW);
}

describe('live source configuration boundary', () => {
  it('requires a pinned host key for live sources', () => {
    const config = serverConfig('smp', '/srv/smp');
    delete (config as { hostKeySha256?: string }).hostKeySha256;
    expect(() => compileConfig({ servers: [config] })).toThrow(/hostKeySha256/);
  });

  it('rejects configured sources outside allowlisted roots', () => {
    const config = serverConfig('smp', '/srv/smp');
    config.liveSource.approvedFiles[0]!.path = '/etc/server.properties';
    expect(() => compileConfig({ servers: [config] })).toThrow(/outside every allowlisted root/);
  });

  it('rejects credential-bearing files even when explicitly named', () => {
    const config = serverConfig('smp', '/srv/smp');
    config.liveSource.approvedFiles[0]!.path = '/srv/smp/credentials.yml';
    expect(() => compileConfig({ servers: [config] })).toThrow(/secret-deny/);
  });

  it('keeps source identifiers unique within a server', () => {
    const config = serverConfig('smp', '/srv/smp');
    config.liveSource.approvedFiles[0]!.id = 'plugins';
    expect(() => compileConfig({ servers: [config] })).toThrow(/ids must be unique/);
  });
});

describe('approved live reads and secret boundary', () => {
  it('reads an approved file with live hash/path/server provenance and redacts credential fields', async () => {
    const server = makeServer();
    const gateway = gatewayFor({ smp: server });
    const out = await gateway.readApprovedFile('smp', 'server-properties');

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.server).toEqual({ id: 'smp', displayName: 'SMP', environment: 'production' });
    expect(out.result.content).toContain('motd=Welcome to Enthusia');
    expect(out.result.content).not.toContain('TEST_ONLY_SECRET_VALUE');
    expect(out.result.content).not.toContain('TEST_ONLY_DISCORD_VALUE');
    expect(out.result.content).not.toContain('jdbc:mysql');
    expect(out.result.redactionCount).toBeGreaterThanOrEqual(3);
    expect(out.result.provenance.file.path).toBe('/srv/smp/server.properties');
    expect(out.result.provenance.file.version).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.result.provenance.targetServer.id).toBe('smp');
    expect(out.result.provenance.observedAt).toBe(FIXED_NOW.toISOString());
  });

  it('publishes only allowlisted deployment identity fields', async () => {
    const gateway = gatewayFor({ smp: makeServer() });
    const out = await gateway.readApprovedFile('smp', 'deployment');

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.content).toBeUndefined();
    expect(out.result.deploymentIdentity).toEqual({
      deploymentId: 'release-2026-10-04',
      runtimeVersion: '2026.10.04.1',
      gitSha: '1234567abcdef',
      buildId: '4242',
      deployedAt: '2026-10-04T19:55:00Z',
    });
    expect(out.result.redactedFields).toContain('apiToken');
  });
});

describe('plugin intelligence primitives', () => {
  it('lists deployed JAR identities without reading arbitrary files', async () => {
    const server = makeServer();
    const gateway = gatewayFor({ smp: server });
    const out = await gateway.listPlugins('smp', 'plugins');

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.plugins).toHaveLength(1);
    expect(out.result.plugins[0]?.deployedFile.fileName).toBe('ExamplePlugin.jar');
    expect(out.result.plugins[0]?.deployedFile.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('extracts safe plugin metadata and keeps Git/build/deployed/server identities distinct', async () => {
    const gateway = gatewayFor({ smp: makeServer() });
    const out = await gateway.inspectPlugin('smp', 'plugins', 'ExamplePlugin.jar');

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.plugin).toMatchObject({
      status: 'OK',
      name: 'ExamplePlugin',
      version: '2.0.0',
      mainClass: 'net.example.ExamplePlugin',
      dependencies: ['Vault'],
      softDependencies: ['PlaceholderAPI'],
      commands: ['example'],
      permissions: ['example.use'],
    });
    expect(out.result.gitSource).toEqual({ sha: 'abcdef123456', evidence: 'jar-metadata' });
    expect(out.result.buildArtifact.buildVersion).toBe('build-42');
    expect(out.result.buildArtifact.buildId).toBe('42');
    expect(out.result.deployedFile.sha256).not.toBe(out.result.gitSource?.sha);
    expect(out.result.targetServer.id).toBe('smp');
    expect(out.result.runtimeIdentity).toMatchObject({
      pluginVersion: '2.0.0',
      buildVersion: 'build-42',
      buildId: '42',
    });
  });

  it('reports malformed archives without executing or crashing on them', async () => {
    const server = makeServer();
    server.writeFile('/srv/smp/plugins/Broken.jar', 'not-a-zip', 1_700_000_000_500);
    const gateway = gatewayFor({ smp: server });
    const out = await gateway.inspectPlugin('smp', 'plugins', 'Broken.jar');

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.plugin).toMatchObject({
      status: 'MALFORMED',
      metadataError: 'invalid-archive',
    });
    expect(out.result.deployedFile.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports malformed plugin metadata as metadata state', async () => {
    const server = makeServer();
    server.writeFile('/srv/smp/plugins/BadMeta.jar', storedZip({
      'plugin.yml': 'name: BadMeta\nversion: 1\n',
    }), 1_700_000_000_600);
    const gateway = gatewayFor({ smp: server });
    const out = await gateway.inspectPlugin('smp', 'plugins', 'BadMeta.jar');

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.plugin).toMatchObject({
      status: 'MALFORMED',
      metadataError: 'invalid-descriptor',
    });
  });
});

describe('bounded untrusted JAR metadata parsing', () => {
  it('rejects an overlong descriptor line without dynamic-regex work', () => {
    const jar = storedZip({
      'plugin.yml': [
        'name: ' + 'x'.repeat(20_000),
        'version: 1.0.0',
        'main: net.example.Main',
      ].join('\n'),
    });
    const parsed = parsePluginJar(jar, 64 * 1024);

    expect(parsed.plugin).toMatchObject({
      status: 'MALFORMED',
      metadataError: 'invalid-descriptor',
    });
  });

  it('rejects excessive descriptor line counts within the byte budget', () => {
    const lines = ['name: Example', 'version: 1.0.0', 'main: net.example.Main'];
    for (let index = 0; index < 8_300; index += 1) lines.push('# filler');
    const parsed = parsePluginJar(storedZip({ 'plugin.yml': lines.join('\n') }), 128 * 1024);

    expect(parsed.plugin).toMatchObject({
      status: 'MALFORMED',
      metadataError: 'invalid-descriptor',
    });
  });
});

describe('path, size, timeout, and failure isolation', () => {
  it('rejects traversal-like JAR names before touching SFTP', async () => {
    const server = makeServer();
    server.operations.length = 0;
    const gateway = gatewayFor({ smp: server });
    const out = await gateway.inspectPlugin('smp', 'plugins', '../outside.jar');

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('INVALID_REQUEST');
    expect(server.operations).toEqual([]);
  });

  it('blocks a symlink escape without reading the escaped target', async () => {
    const server = makeServer();
    server.writeFile('/outside/Escape.jar', pluginJar(), 1_700_000_000_700);
    server.symlink('/srv/smp/plugins/Escape.jar', '/outside/Escape.jar');
    server.operations.length = 0;
    const gateway = gatewayFor({ smp: server });
    const out = await gateway.inspectPlugin('smp', 'plugins', 'Escape.jar');

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('PATH_DENIED');
    expect(server.touched('readFile:/outside/Escape.jar')).toBe(false);
    expect(server.touched('hashFile:/outside/Escape.jar')).toBe(false);
  });

  it('rejects oversized JAR reads before reading bytes', async () => {
    const server = makeServer();
    server.operations.length = 0;
    const gateway = gatewayFor({ smp: server }, 64);
    const out = await gateway.inspectPlugin('smp', 'plugins', 'ExamplePlugin.jar');

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('OVERSIZE');
    expect(server.count('readFile:')).toBe(0);
  });

  it('times out a stalled read and closes the source client', async () => {
    const server = makeServer();
    server.readFile = async () => new Promise<Buffer>(() => undefined);
    const config = serverConfig('smp', '/srv/smp');
    config.liveSource.operationTimeoutMs = 20;
    const compiled = compileConfig({ servers: [config] });
    const gateway = new LiveServerSourceGateway(compiled, async () => server, () => FIXED_NOW);
    const out = await gateway.inspectPlugin('smp', 'plugins', 'ExamplePlugin.jar');

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('TIMEOUT');
    expect(out.error.retryable).toBe(true);
    expect(server.count('close')).toBeGreaterThan(0);
  });

  it('returns a safe unreachable result instead of throwing', async () => {
    const server = makeServer();
    const gateway = gatewayFor(
      { smp: server },
      1024 * 1024,
      async () => {
        throw new Error('simulated transport failure containing internal detail');
      },
    );
    const out = await gateway.listPlugins('smp', 'plugins');

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toEqual({
      code: 'UNREACHABLE',
      message: 'server source is unreachable',
      retryable: true,
    });
  });

  it('honors cancellation without exposing transport state', async () => {
    const server = makeServer();
    const gateway = gatewayFor({ smp: server });
    const controller = new AbortController();
    controller.abort();
    const out = await gateway.listPlugins('smp', 'plugins', { signal: controller.signal });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('ABORTED');
  });
});

describe('config discovery and server identity', () => {
  it('discovers only safe allowlisted config files and never touches denied names', async () => {
    const server = makeServer();
    server.operations.length = 0;
    const gateway = gatewayFor({ smp: server });
    const out = await gateway.discoverConfigs('smp', 'configs');

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.files.some((item) => item.file.path.endsWith('/config.yml'))).toBe(true);
    expect(out.result.files.some((item) => item.file.path.includes('token-cache'))).toBe(false);
    expect(server.touched('token-cache.yml')).toBe(false);
  });

  it('keeps multiple target server identities distinct in every result', async () => {
    const smp = makeServer('/srv/smp');
    const proxy = makeServer('/srv/proxy');
    const gateway = gatewayFor({ smp, proxy });

    expect(gateway.listServers()).toEqual([
      { id: 'smp', displayName: 'SMP', environment: 'production' },
      { id: 'proxy', displayName: 'PROXY', environment: 'production' },
    ]);

    const smpRead = await gateway.readApprovedFile('smp', 'server-properties');
    const proxyRead = await gateway.readApprovedFile('proxy', 'server-properties');
    expect(smpRead.server.id).toBe('smp');
    expect(proxyRead.server.id).toBe('proxy');
  });
});

describe('read-only public surface', () => {
  it('does not expose write, shell, deploy, restart, reload, delete, or chmod operations', () => {
    const methods = Object.getOwnPropertyNames(LiveServerSourceGateway.prototype);
    for (const forbidden of ['write', 'exec', 'shell', 'deploy', 'restart', 'reload', 'delete', 'chmod']) {
      expect(methods.some((method) => method.toLowerCase().includes(forbidden))).toBe(false);
    }
    expect(methods).toEqual(expect.arrayContaining([
      'listServers',
      'listPlugins',
      'inspectPlugin',
      'discoverConfigs',
      'readApprovedFile',
    ]));
  });
});
