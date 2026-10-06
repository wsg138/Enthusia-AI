import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import {
  LivePolicyCatalogProvider,
  LivePolicySourceError,
  type ApprovedPolicyReader,
} from '../src/live-policy.js';

const POLICY = [
  'version: "runtime-v1"',
  'defaults:',
  '  reportable: true',
  'reasons:',
  '  - id: chat.harassment',
  '    family: chat',
  '    display-name: Harassment',
  '    severity: 70',
].join('\n');

function liveResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    server: {
      id: 'smp',
      displayName: 'SMP',
      environment: 'production',
    },
    observedAt: '2026-10-06T21:00:00.000Z',
    result: {
      sourceId: 'enthusia-staff-reason-policies',
      kind: 'config' as const,
      visibility: Visibility.STAFF,
      content: POLICY,
      redactedFields: [],
      redactionCount: 0,
      provenance: {
        source: 'sftp-live' as const,
        targetServer: {
          id: 'smp',
          displayName: 'SMP',
          environment: 'production',
        },
        file: {
          path: '/srv/smp/plugins/EnthusiaStaff/reason-policies.yml',
          fileName: 'reason-policies.yml',
          sha256: 'a'.repeat(64),
          version: 'sha256:' + 'a'.repeat(64),
          sizeBytes: 1024,
          modifiedAt: '2026-10-06T20:59:00.000Z',
        },
        observedAt: '2026-10-06T21:00:00.000Z',
        freshness: {
          kind: 'live-sha256' as const,
          version: 'sha256:' + 'a'.repeat(64),
        },
      },
      ...overrides,
    },
  };
}

function providerFor(
  result: ReturnType<typeof liveResult> | {
    ok: false;
    server: { id: string; displayName: string; environment: string };
    observedAt: string;
    error: {
      code: 'SOURCE_UNAVAILABLE';
      message: string;
      retryable: boolean;
    };
  },
) {
  const reader: ApprovedPolicyReader = {
    async readApprovedFile(serverId, sourceId) {
      expect(serverId).toBe('smp');
      expect(sourceId).toBe('enthusia-staff-reason-policies');
      return result;
    },
  };
  return new LivePolicyCatalogProvider(reader, {
    serverId: 'smp',
    sourceId: 'enthusia-staff-reason-policies',
    environment: 'production',
  });
}

describe('LivePolicyCatalogProvider', () => {
  it('turns a fresh approved deployed file into CURRENT policy truth', async () => {
    const catalog = await providerFor(liveResult()).read();

    expect(catalog.policyVersion).toBe('runtime-v1');
    expect(catalog.provenance).toEqual({
      sourceId: 'enthusia-staff-reason-policies',
      fileVersion: 'sha256:' + 'a'.repeat(64),
      observedAt: '2026-10-06T21:00:00.000Z',
      sourceStatus: 'CURRENT',
    });
    expect(catalog.rules[0]).toMatchObject({
      id: 'chat.harassment',
      severityBand: 'high',
    });
  });

  it('does not fall back when the live source is unavailable', async () => {
    const provider = providerFor({
      ok: false,
      server: { id: 'smp', displayName: 'SMP', environment: 'production' },
      observedAt: '2026-10-06T21:00:00.000Z',
      error: {
        code: 'SOURCE_UNAVAILABLE',
        message: 'source unavailable',
        retryable: true,
      },
    });

    await expect(provider.read()).rejects.toThrow(
      /Live moderation policy is unavailable/,
    );
  });

  it('rejects wrong environment, redacted policy, or wrong source identity', async () => {
    const wrongEnvironment = liveResult();
    wrongEnvironment.server.environment = 'staging';
    await expect(providerFor(wrongEnvironment).read()).rejects.toThrow(
      /environment did not match/,
    );

    await expect(
      providerFor(liveResult({ redactionCount: 1 })).read(),
    ).rejects.toThrow(/redacted/);

    await expect(
      providerFor(liveResult({ sourceId: 'other-policy' })).read(),
    ).rejects.toThrow(/source identity did not match/);
  });

  it('requires config-kind non-empty policy content', async () => {
    await expect(
      providerFor(liveResult({ kind: 'server-properties' })).read(),
    ).rejects.toThrow(LivePolicySourceError);

    await expect(
      providerFor(liveResult({ content: '   ' })).read(),
    ).rejects.toThrow(/no content/);
  });
});
