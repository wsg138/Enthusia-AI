/** Types for the separately maintained Node ESM staging model preflight. */
export interface ManagedInferenceSpec {
  executable: string;
  args: string[];
  port: number;
  modelName: string;
  threads: number;
}
export function prepareManagedInference(
  env: Record<string, string | undefined>,
  inferencePort: number,
): Promise<ManagedInferenceSpec>;
