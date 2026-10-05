import { expect, it } from 'vitest';
import { compileConfig } from '../src/config.js';
import {
  gatewayFor,
  makeServer,
  serverConfig,
} from './live-source-fixtures.js';

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

it('redacts credential fields from an approved live read', async () => {
  const out = await gatewayFor({ smp: makeServer() })
    .readApprovedFile('smp', 'server-properties');

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
});

it('publishes only allowlisted deployment identity fields', async () => {
  const out = await gatewayFor({ smp: makeServer() })
    .readApprovedFile('smp', 'deployment');

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

it('keeps multiple server identities distinct in every result', async () => {
  const gateway = gatewayFor({
    smp: makeServer('/srv/smp'),
    proxy: makeServer('/srv/proxy'),
  });
  expect(gateway.listServers()).toEqual([
    { id: 'smp', displayName: 'SMP', environment: 'production' },
    { id: 'proxy', displayName: 'PROXY', environment: 'production' },
  ]);

  const smpRead = await gateway.readApprovedFile('smp', 'server-properties');
  const proxyRead = await gateway.readApprovedFile('proxy', 'server-properties');
  expect(smpRead.server.id).toBe('smp');
  expect(proxyRead.server.id).toBe('proxy');
});
