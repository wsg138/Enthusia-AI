import { describe, expect, it } from 'vitest';
import { parseCpuQuota, parseMemoryLimit, runProbe } from '../../deploy/bloom/probe-node-generic.mjs';

describe('Bloom Node generic zero-secret capability probe', () => {
  it('interprets cgroup v2 and v1 memory limits without treating infinity as RAM', () => {
    expect(parseMemoryLimit(String(5 * 1024 ** 3))).toBe(5 * 1024 ** 3);
    expect(parseMemoryLimit('max')).toBeNull();
    expect(parseMemoryLimit(String(2 ** 62))).toBeNull();
    expect(parseMemoryLimit('0')).toBeNull();
    expect(parseMemoryLimit('not available')).toBeNull();
  });

  it('interprets CPU quotas without assuming the host CPU count is the allocation', () => {
    expect(parseCpuQuota('200000 100000')).toBe(2);
    expect(parseCpuQuota('25000 100000')).toBe(0.25);
    expect(parseCpuQuota('max 100000')).toBeNull();
    expect(parseCpuQuota('-1 100000')).toBeNull();
    expect(parseCpuQuota('abc')).toBeNull();
  });

  it('runs without any tokens, network connection or native-model downloads', async () => {
    const report = await runProbe();
    expect(report.probe).toBe('enthusia-bloom-node-generic-v1');
    expect(report.nodeMajor).toBe(Number(process.versions.node.split('.')[0]));
    expect(report.node24Compatible).toBe(report.nodeMajor === 24);
    expect(report.nodeChildProcessesWork).toBe(true);
    expect(report.workspaceWritable).toBe(true);
    expect(['allowed', 'blocked', 'binary-missing', 'unknown', 'not-tested'])
      .toContain(report.copiedNativeExecutable);
    expect(report.inferenceModelLoaded).toBe(false);
    expect(report.persistentAfterRestart).toBe('not-tested');
    expect(report.customDockerImageAllowed).toBe('not-tested');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/TOKEN|PASSWORD|PRIVATE_KEY|SFTP|DISCORD_BOT/i);
    expect(Object.keys(report).sort()).toEqual([
      'architecture', 'cgroup', 'copiedNativeExecutable', 'customDockerImageAllowed',
      'hostMemoryGiB', 'inferenceModelLoaded', 'linux', 'node24Compatible',
      'nodeChildProcessesWork', 'nodeMajor', 'persistentAfterRestart',
      'platform', 'probe', 'workspaceWritable',
    ].sort());
  });
});
