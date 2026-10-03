import { z } from 'zod';

/**
 * Health and observability contracts.
 *
 * Spec: MASTER-SPECIFICATION.md §36.
 * Every service requires /health/live and /health/ready (where appropriate),
 * structured logs, request IDs, metrics, startup version, dependency status.
 */

export type HealthStatus = 'ok' | 'degraded' | 'down';

export const HEALTH_STATUSES: readonly HealthStatus[] = ['ok', 'degraded', 'down'] as const;

export interface DependencyHealth {
  /** Dependency name, e.g. 'postgres', 'qdrant', 'llama.cpp'. */
  name: string;
  status: HealthStatus;
  latencyMs?: number;
  detail?: string;
}

/** GET /health/live — is the process alive? */
export interface LivenessResponse {
  status: 'ok';
  /** Service version (startup version, §36). */
  version: string;
  uptimeSeconds: number;
}

/** GET /health/ready — can the service serve traffic? */
export interface ReadinessResponse {
  status: HealthStatus;
  version: string;
  uptimeSeconds: number;
  dependencies: DependencyHealth[];
  /** Whether an inference model is currently loaded (§36). */
  modelLoaded: boolean;
  /** Resident model memory in bytes (§36 model RAM). */
  modelRamBytes?: number;
  /** Number of requests currently being processed. */
  activeRequests?: number;
  /** Depth of the inference work queue. */
  queueDepth?: number;
}

const dependencyHealthSchema = z.object({
  name: z.string().min(1),
  status: z.enum(HEALTH_STATUSES),
  latencyMs: z.number().nonnegative().optional(),
  detail: z.string().optional(),
});

export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
});

export const readinessResponseSchema = z.object({
  status: z.enum(HEALTH_STATUSES),
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
  dependencies: z.array(dependencyHealthSchema),
  modelLoaded: z.boolean(),
  modelRamBytes: z.number().int().nonnegative().optional(),
  activeRequests: z.number().int().nonnegative().optional(),
  queueDepth: z.number().int().nonnegative().optional(),
});
