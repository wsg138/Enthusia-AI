import { expect, it } from 'vitest';
import { compileConfig } from '../src/config.js';
import { LiveServerSourceGateway } from '../src/live-source.js';
import {
  FIXED_NOW,
  gatewayFor,
  makeServer,
  pluginJar,
  serverConfig,
} from './live-source-fixtures.js';

it('rejects traversal-like JAR names before touching SFTP', async () => {
  const server = makeServer();
  server.operations.length = 0;
  const out = await gatewayFor({ smp: server })
    .inspectPlugin('smp', 'plugins', '../outside.jar');

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
  const out = await gatewayFor({ smp: server })
    .inspectPlugin('smp', 'plugins', 'Escape.jar');

  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.error.code).toBe('PATH_DENIED');
  expect(server.touched('readFile:/outside/Escape.jar')).toBe(false);
  expect(server.touched('hashFile:/outside/Escape.jar')).toBe(false);
});

it('rejects oversized JARs before reading bytes', async () => {
  const server = makeServer();
  server.operations.length = 0;
  const out = await gatewayFor({ smp: server }, 64)
    .inspectPlugin('smp', 'plugins', 'ExamplePlugin.jar');

  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.error.code).toBe('OVERSIZE');
  expect(server.count('readFile:')).toBe(0);
});

it('times out a stalled read and closes the client', async () => {
  const server = makeServer();
  server.readFile = async () => new Promise<Buffer>(() => undefined);
  const config = serverConfig('smp', '/srv/smp');
  config.liveSource.operationTimeoutMs = 20;
  const gateway = new LiveServerSourceGateway(
    compileConfig({ servers: [config] }),
    async () => server,
    () => FIXED_NOW,
  );
  const out = await gateway.inspectPlugin('smp', 'plugins', 'ExamplePlugin.jar');

  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.error).toMatchObject({ code: 'TIMEOUT', retryable: true });
  expect(server.count('close')).toBeGreaterThan(0);
});

it('returns a safe unreachable result instead of throwing transport detail', async () => {
  const gateway = gatewayFor(
    { smp: makeServer() },
    1024 * 1024,
    async () => {
      throw new Error('simulated transport detail');
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

it('maps a synchronously throwing client factory to unreachable', async () => {
  const gateway = gatewayFor(
    { smp: makeServer() },
    1024 * 1024,
    () => {
      throw new Error('synchronous simulated transport failure');
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
  const controller = new AbortController();
  controller.abort();
  const out = await gatewayFor({ smp: makeServer() })
    .listPlugins('smp', 'plugins', { signal: controller.signal });

  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.error.code).toBe('ABORTED');
});

it('discovers only safe config files and never touches denied names', async () => {
  const server = makeServer();
  server.operations.length = 0;
  const out = await gatewayFor({ smp: server }).discoverConfigs('smp', 'configs');

  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.result.files.some((item) => item.file.path.endsWith('/config.yml'))).toBe(true);
  expect(out.result.files.some((item) => item.file.path.includes('token-cache'))).toBe(false);
  expect(server.touched('token-cache.yml')).toBe(false);
});
