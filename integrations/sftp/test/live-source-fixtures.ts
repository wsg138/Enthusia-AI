import { Visibility } from '@enthusia/contracts';
import { compileConfig } from '../src/config.js';
import {
  LiveServerSourceGateway,
  type LiveSftpClientFactory,
} from '../src/live-source.js';
import { MockSftpServer } from './fakes.js';

export const HOST_KEY = 'SHA256:' + 'A'.repeat(43);
export const FIXED_NOW = new Date('2026-10-04T20:00:00.000Z');

function localHeader(nameBytes: Buffer, data: Buffer): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(0, 10);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(
  nameBytes: Buffer,
  data: Buffer,
  offset: number,
): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

function endDirectory(entryCount: number, centralSize: number, localSize: number): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localSize, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

export function storedZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const local = localHeader(nameBytes, data);
    locals.push(local, nameBytes, data);
    centrals.push(centralHeader(nameBytes, data, offset), nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  return Buffer.concat([
    localBytes,
    centralBytes,
    endDirectory(Object.keys(entries).length, centralBytes.length, localBytes.length),
  ]);
}

export function pluginJar(): Buffer {
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

function pluginDirectories(root: string) {
  return [
    {
      id: 'plugins',
      path: root + '/plugins',
      visibility: Visibility.STAFF,
    },
  ];
}

function configDirectories(root: string) {
  return [
    {
      id: 'configs',
      path: root + '/plugins',
      visibility: Visibility.STAFF,
      includeExtensions: ['.yml', '.yaml', '.json', '.properties'],
      maxDepth: 3,
    },
  ];
}

function approvedFiles(root: string) {
  return [
    {
      id: 'server-properties',
      path: root + '/server.properties',
      kind: 'server-properties' as const,
      format: 'properties' as const,
      visibility: Visibility.STAFF,
      safeValues: [
        { id: 'motd', path: ['motd'] },
        { id: 'rcon-password-test', path: ['rcon.password'] },
      ],
    },
    {
      id: 'example-config',
      path: root + '/plugins/ExamplePlugin/config.yml',
      kind: 'config' as const,
      format: 'yaml' as const,
      visibility: Visibility.STAFF,
      safeValues: [
        { id: 'feature-enabled', path: ['feature'] },
      ],
    },
    {
      id: 'deployment',
      path: root + '/deployment.properties',
      kind: 'deployment-identity' as const,
      format: 'properties' as const,
      visibility: Visibility.STAFF,
    },
  ];
}

export function serverConfig(
  id: string,
  root: string,
  maxJarBytes = 1024 * 1024,
) {
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
      pluginDirectories: pluginDirectories(root),
      configDirectories: configDirectories(root),
      approvedFiles: approvedFiles(root),
    },
  };
}

export function makeServer(root = '/srv/smp'): MockSftpServer {
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

export function gatewayFor(
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
