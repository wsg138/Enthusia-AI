import { expect, it } from 'vitest';
import {
  SourceStatus,
  Visibility,
  type Actor,
} from '@enthusia/contracts';
import { compileConfig } from '../src/config.js';
import { LiveServerSourceGateway } from '../src/live-source.js';
import { createLiveServerSourceTools } from '../src/live-tools.js';
import { MockSftpServer } from './fakes.js';
import type { ToolCallContext } from '../src/tool-adapter.js';

const HOST_KEY = 'SHA256:' + 'B'.repeat(43);

function compiled() {
  return compileConfig({
    servers: [
      {
        id: 'smp',
        host: 'smp.example.invalid',
        username: 'readonly-test-user',
        authRef: 'TEST_ONLY_SMP_SFTP',
        hostKeySha256: HOST_KEY,
        roots: [{ path: '/srv/smp' }],
        liveSource: {
          pluginDirectories: [{ id: 'plugins', path: '/srv/smp/plugins' }],
          configDirectories: [{ id: 'configs', path: '/srv/smp/plugins' }],
          approvedFiles: [
            {
              id: 'server-properties',
              path: '/srv/smp/server.properties',
              kind: 'server-properties',
              format: 'properties',
            },
          ],
        },
      },
    ],
  });
}

function context(actor: Actor, ceiling = Visibility.STAFF): ToolCallContext {
  return {
    traceId: 'trace-live-source',
    actor,
    visibilityCeiling: ceiling,
  };
}

function contextWithSignal(actor: Actor, signal: AbortSignal): ToolCallContext {
  return {
    ...context(actor),
    signal,
  };
}

const STAFF: Actor = { id: 'staff-1', type: 'staff' };
const PLAYER: Actor = { id: 'player-1', type: 'player' };

  it('exposes only typed operations and no arbitrary path parameter', () => {
    const gateway = new LiveServerSourceGateway(compiled(), async () => new MockSftpServer());
    const toolset = createLiveServerSourceTools(gateway);

    expect(toolset.names).toEqual([
      'server.list_plugins',
      'server.inspect_plugin',
      'server.discover_configs',
      'server.read_approved_file',
    ]);
    for (const tool of toolset.tools) {
      expect(tool.meta.verificationTier).toBe('A');
      expect(tool.meta.maxVisibility).toBe(Visibility.STAFF);
      expect(tool.meta.privacySensitive).toBe(true);
      expect(tool.meta.parameters.properties['path']).toBeUndefined();
      expect(tool.meta.parameters.properties['remotePath']).toBeUndefined();
    }
  });

  it('rejects non-staff before opening any live connection', async () => {
    let connections = 0;
    const gateway = new LiveServerSourceGateway(compiled(), async () => {
      connections += 1;
      return new MockSftpServer();
    });
    const tool = createLiveServerSourceTools(gateway).get('server.read_approved_file')!;
    const out = await tool.execute(
      { serverId: 'smp', sourceId: 'server-properties' },
      context(PLAYER),
    );

    expect(out.error).toMatchObject({
      code: 'VISIBILITY_DENIED',
      retryable: false,
    });
    expect(out.result).toBeUndefined();
    expect(connections).toBe(0);
  });

  it('rejects unknown parameters before opening a connection', async () => {
    let connections = 0;
    const gateway = new LiveServerSourceGateway(compiled(), async () => {
      connections += 1;
      return new MockSftpServer();
    });
    const tool = createLiveServerSourceTools(gateway).get('server.read_approved_file')!;
    const out = await tool.execute(
      {
        serverId: 'smp',
        sourceId: 'server-properties',
        path: '/etc/passwd',
      },
      context(STAFF),
    );

    expect(out.error?.code).toBe('INVALID_PARAMS');
    expect(connections).toBe(0);
  });

  it('propagates cancellation through the typed tool without recursion', async () => {
    const gateway = new LiveServerSourceGateway(
      compiled(),
      async () => new Promise<MockSftpServer>(() => undefined),
    );
    const tool = createLiveServerSourceTools(gateway).get('server.list_plugins')!;
    const controller = new AbortController();

    const pending = tool.execute(
      { serverId: 'smp', directoryId: 'plugins' },
      contextWithSignal(STAFF, controller.signal),
    );
    controller.abort();
    const out = await pending;

    expect(out.error).toMatchObject({
      code: 'ABORTED',
      retryable: false,
    });
  });

  it('returns server identity, safe data, and CURRENT freshness for staff', async () => {
    const server = new MockSftpServer();
    server.writeFile(
      '/srv/smp/server.properties',
      'motd=Enthusia\nrcon.password=TEST_ONLY_SECRET\n',
      1_700_000_000_000,
    );
    const gateway = new LiveServerSourceGateway(
      compiled(),
      async () => server,
      () => new Date('2026-10-04T20:00:00.000Z'),
    );
    const tool = createLiveServerSourceTools(gateway).get('server.read_approved_file')!;
    const out = await tool.execute(
      { serverId: 'smp', sourceId: 'server-properties' },
      context(STAFF),
    );

    expect(out.error).toBeUndefined();
    expect(out.toolName).toBe('server.read_approved_file');
    expect(out.source).toBe('sftp-live:smp');
    expect(out.visibility).toBe(Visibility.STAFF);
    expect(out.correlationId).toBe('trace-live-source');
    expect(out.result).toMatchObject({
      server: { id: 'smp', displayName: 'smp', environment: 'production' },
    });
    expect(JSON.stringify(out.result)).not.toContain('TEST_ONLY_SECRET');

    const freshness = JSON.parse(out.freshness ?? '{}') as Record<string, unknown>;
    expect(freshness['version']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(freshness['observedTime']).toBe('2026-10-04T20:00:00.000Z');
    expect(freshness['sourceStatus']).toBe(SourceStatus.CURRENT);
  });
