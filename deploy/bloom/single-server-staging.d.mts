/** Types for the Node ESM staging-only Bloom supervisor. */
export type StagingEnvironment = Record<string, string | undefined>;

export interface SingleServerPlan {
  root: string;
  resolver: string;
  paths: Array<[string, string, number | null]>;
  agentPort: number;
  gatewayPort: number;
  inferenceUrl: string;
  inferencePort: number;
  withDiscord: boolean;
  managedInference: boolean;
  managedIndexer: boolean;
  indexerPort: number;
  dryRun: boolean;
  smoke: boolean;
}
export function planSingleServer(
  args?: string[],
  env?: StagingEnvironment,
): SingleServerPlan;

export function makeStagingEnvironments(
  plan: SingleServerPlan,
  env?: StagingEnvironment,
): {
  agent: StagingEnvironment;
  gateway: StagingEnvironment;
  discord: StagingEnvironment;
  inference: StagingEnvironment;
  knowledge: StagingEnvironment;
};
export function untilKnowledgeReady(
  port: number,
  apiKey: string,
  child: { exitCode: number | null; signalCode: string | null },
  timeoutMs?: number,
): Promise<void>;
export function runSingleServer(
  plan: SingleServerPlan,
  env?: StagingEnvironment,
): Promise<void>;

export function untilInferenceReady(
  port: number,
  modelName: string,
  apiKey: string,
  child: { exitCode: number | null; signalCode: string | null },
  timeoutMs?: number,
): Promise<void>;
