import { expect, it } from 'vitest';
import {
  readCurrentPluginDeployment,
  readCurrentPluginInterface,
  readCurrentTargetFreshness,
} from '../src/current-intelligence.js';
import { gatewayFor, makeServer } from './live-source-fixtures.js';

it('returns a compact deployment identity without exposing a filesystem path', async () => {
  const out = await readCurrentPluginDeployment(
    gatewayFor({ smp: makeServer() }),
    'smp',
    'plugins',
    'ExamplePlugin.jar',
  );

  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.result).toMatchObject({
    directoryId: 'plugins',
    evidence: 'deployed-jar-inspection',
    plugin: {
      status: 'OK',
      name: 'ExamplePlugin',
      version: '2.0.0',
      mainClass: 'net.example.ExamplePlugin',
    },
    deployed: {
      fileName: 'ExamplePlugin.jar',
      sizeBytes: expect.any(Number),
      modifiedAt: expect.any(String),
    },
    source: {
      gitSource: { sha: 'abcdef123456', evidence: 'jar-metadata' },
    },
    dependencies: {
      required: ['Vault'],
      optional: ['PlaceholderAPI'],
      loadBefore: [],
    },
  });
  expect(out.result.deployed.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(out.result)).not.toContain('/srv/smp');
});

it('marks the live read path CURRENT after inspecting one explicit anchor JAR', async () => {
  const out = await readCurrentTargetFreshness(
    gatewayFor({ smp: makeServer() }),
    'smp',
    'plugins',
    'ExamplePlugin.jar',
  );

  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.result).toEqual({
    directoryId: 'plugins',
    state: 'CURRENT',
    scope: 'read-path',
    evidence: 'live-plugin-inspection',
    anchor: {
      fileName: 'ExamplePlugin.jar',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      modifiedAt: expect.any(String),
    },
  });
  expect(out.observedAt).toBe('2026-10-04T20:00:00.000Z');
});

it('keeps failed target reads as typed failures instead of claiming freshness', async () => {
  const gateway = gatewayFor(
    { smp: makeServer() },
    1024 * 1024,
    async () => {
      throw new Error('simulated unreachable');
    },
  );
  const out = await readCurrentTargetFreshness(
    gateway,
    'smp',
    'plugins',
    'ExamplePlugin.jar',
  );

  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.error.code).toBe('UNREACHABLE');
});

it('labels command and permission data as deployed metadata declarations', async () => {
  const out = await readCurrentPluginInterface(
    gatewayFor({ smp: makeServer() }),
    'smp',
    'plugins',
    'ExamplePlugin.jar',
  );

  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.result).toEqual(expect.objectContaining({
    directoryId: 'plugins',
    evidence: 'deployed-plugin-metadata',
    plugin: {
      status: 'OK',
      name: 'ExamplePlugin',
      version: '2.0.0',
    },
    deployed: {
      fileName: 'ExamplePlugin.jar',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    },
    declaredCommands: ['example'],
    declaredPermissions: ['example.use'],
    caveat: 'metadata-declarations-do-not-prove-runtime-registration',
  }));
  expect(JSON.stringify(out.result)).not.toContain('/srv/smp');
});
