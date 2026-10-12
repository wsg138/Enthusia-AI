/** Types for the one-shot, local-only Bloom generic Node capability probe. */
export type BloomNativeExecutableResult = 'not-tested' | 'allowed' | 'blocked' | 'binary-missing' | 'unknown';

export interface BloomNodeGenericReport {
  probe: 'enthusia-bloom-node-generic-v1';
  linux: boolean;
  platform: string;
  architecture: string;
  nodeMajor: number;
  node24Compatible: boolean;
  nodeChildProcessesWork: boolean;
  hostMemoryGiB: number;
  cgroup: {
    memoryBytes: number | null;
    cpuCores: number | null;
    source: 'not-linux' | 'not-exposed' | 'cgroup';
  };
  workspaceWritable: boolean;
  copiedNativeExecutable: BloomNativeExecutableResult;
  persistentAfterRestart: 'not-tested';
  customDockerImageAllowed: 'not-tested';
  inferenceModelLoaded: false;
}

export function parseMemoryLimit(value: string | null | undefined): number | null;
export function parseCpuQuota(value: string | null | undefined): number | null;
export function runProbe(): Promise<BloomNodeGenericReport>;
