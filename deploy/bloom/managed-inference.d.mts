/** Types for the separately maintained Node ESM staging model preflight. */
export interface ManagedInferenceSpec {
  executable: string;
  args: string[];
  port: number;
  modelName: string;
  threads: number;
  /** Linux staging only: verified binary FD for child 3, GGUF FD for child 4. */
  descriptorFds?: [number, number];
  /** Idempotent parent-side close after POSIX spawn has inherited the FDs. */
  closePinnedFiles?: () => Promise<void>;
}
export function prepareManagedInference(
  env: Record<string, string | undefined>,
  inferencePort: number,
  options?: { verifiedFdLaunch?: boolean },
): Promise<ManagedInferenceSpec>;
