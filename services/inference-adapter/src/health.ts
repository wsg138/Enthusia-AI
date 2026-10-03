import { type HealthStatus, type ReadinessResponse } from '@enthusia/contracts';
import type { InferenceClient } from './client.js';
import type { MetricsSnapshot } from './metrics.js';

/**
 * @enthusia/inference-adapter — inference health checks.
 *
 * Spec: MASTER-SPECIFICATION.md §36. Feeds the service-level /health/ready
 * endpoint (served by the AI gateway / deployment workstreams): this module
 * produces the inference dependency status, including whether a model is
 * loaded and the model name/version.
 *
 * Health semantics:
 * - ok: endpoint reachable and at least one model listed (model loaded);
 * - degraded: endpoint reachable but no models listed (nothing to serve);
 * - down: endpoint unreachable or erroring.
 */

export interface InferenceHealthReport {
  status: HealthStatus;
  /** Whether a model is currently loaded and servable (§36). */
  modelLoaded: boolean;
  /** Model identifier from /v1/models (exposed via health per W03 acceptance). */
  modelName?: string;
  /** Server-reported model version when available. */
  modelVersion?: string;
  /** Probe latency in milliseconds. */
  latencyMs: number;
  /** Visibility-safe detail string. */
  detail?: string;
  /** ISO 8601 timestamp of the check. */
  checkedAt: string;
  /** Current client metrics snapshot. */
  metrics: MetricsSnapshot;
}

/** Probe the inference endpoint and build a health report. */
export async function checkInferenceHealth(
  client: InferenceClient,
  options: { traceId?: string } = {},
): Promise<InferenceHealthReport> {
  const startedAt = Date.now();
  const metrics = client.getMetrics();
  try {
    const models = await client.getModels({ traceId: options.traceId });
    const latencyMs = Date.now() - startedAt;
    const first = models[0];
    if (first === undefined) {
      const report: InferenceHealthReport = {
        status: 'degraded',
        modelLoaded: false,
        latencyMs,
        detail: 'Inference endpoint reachable but no models are loaded.',
        checkedAt: new Date().toISOString(),
        metrics,
      };
      return report;
    }
    const report: InferenceHealthReport = {
      status: 'ok',
      modelLoaded: true,
      modelName: first.id,
      latencyMs,
      detail: `Model '${first.id}' loaded.`,
      checkedAt: new Date().toISOString(),
      metrics,
    };
    if (first.version !== undefined) {
      report.modelVersion = first.version;
    }
    return report;
  } catch (error) {
    const report: InferenceHealthReport = {
      status: 'down',
      modelLoaded: false,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : 'Unknown inference health failure.',
      checkedAt: new Date().toISOString(),
      metrics,
    };
    return report;
  }
}

/**
 * Map an inference health report into the shared /health/ready contract.
 * The gateway serves this; the adapter only produces the inference slice.
 */
export function toReadinessDependency(report: InferenceHealthReport): ReadinessResponse['dependencies'][number] {
  const dependency: ReadinessResponse['dependencies'][number] = {
    name: 'inference',
    status: report.status,
    latencyMs: report.latencyMs,
  };
  const parts: string[] = [];
  if (report.modelName !== undefined) parts.push(`model=${report.modelName}`);
  if (report.modelVersion !== undefined) parts.push(`version=${report.modelVersion}`);
  if (report.detail !== undefined) parts.push(report.detail);
  if (parts.length > 0) dependency.detail = parts.join(' ');
  return dependency;
}
