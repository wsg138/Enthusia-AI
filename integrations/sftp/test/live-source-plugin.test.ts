import { expect, it } from 'vitest';
import { LiveServerSourceGateway } from '../src/live-source.js';
import { parsePluginJar } from '../src/jar-metadata.js';
import {
  gatewayFor,
  makeServer,
  storedZip,
} from './live-source-fixtures.js';

it('lists deployed JAR identities without reading arbitrary files', async () => {
  const out = await gatewayFor({ smp: makeServer() }).listPlugins('smp', 'plugins');
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.result.plugins).toHaveLength(1);
  expect(out.result.plugins[0]?.deployedFile.fileName).toBe('ExamplePlugin.jar');
  expect(out.result.plugins[0]?.deployedFile.sha256).toMatch(/^[0-9a-f]{64}$/);
});

it('keeps Git, build, deployed file, and target server identities distinct', async () => {
  const out = await gatewayFor({ smp: makeServer() })
    .inspectPlugin('smp', 'plugins', 'ExamplePlugin.jar');

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
});

it('reports malformed archives without executing or crashing', async () => {
  const server = makeServer();
  server.writeFile('/srv/smp/plugins/Broken.jar', 'not-a-zip', 1_700_000_000_500);
  const out = await gatewayFor({ smp: server })
    .inspectPlugin('smp', 'plugins', 'Broken.jar');

  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.result.plugin).toMatchObject({
    status: 'MALFORMED',
    metadataError: 'invalid-archive',
  });
});

it('reports malformed plugin metadata as metadata state', async () => {
  const server = makeServer();
  server.writeFile('/srv/smp/plugins/BadMeta.jar', storedZip({
    'plugin.yml': 'name: BadMeta\nversion: 1\n',
  }), 1_700_000_000_600);
  const out = await gatewayFor({ smp: server })
    .inspectPlugin('smp', 'plugins', 'BadMeta.jar');

  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.result.plugin).toMatchObject({
    status: 'MALFORMED',
    metadataError: 'invalid-descriptor',
  });
});

it('bounds maliciously long descriptor lines', () => {
  const parsed = parsePluginJar(storedZip({
    'plugin.yml': [
      'name: ' + 'x'.repeat(20_000),
      'version: 1.0.0',
      'main: net.example.Main',
    ].join('\n'),
  }), 64 * 1024);
  expect(parsed.plugin).toMatchObject({
    status: 'MALFORMED',
    metadataError: 'invalid-descriptor',
  });
});

it('bounds excessive descriptor line counts', () => {
  const lines = ['name: Example', 'version: 1.0.0', 'main: net.example.Main'];
  for (let index = 0; index < 8_300; index += 1) lines.push('# filler');
  const parsed = parsePluginJar(
    storedZip({ 'plugin.yml': lines.join('\n') }),
    128 * 1024,
  );
  expect(parsed.plugin).toMatchObject({
    status: 'MALFORMED',
    metadataError: 'invalid-descriptor',
  });
});

it('exposes no write-like methods on the live gateway', () => {
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
