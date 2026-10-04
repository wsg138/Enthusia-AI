/**
 * @enthusia/metrics — Prometheus-format metrics stub for Enthusia AI services.
 *
 * Spec: MASTER-SPECIFICATION.md §36 (health and observability), §9.2
 * (inference runtime must expose metrics), §31 (startup version recorded).
 *
 * This is a dependency-free stub implementing the Prometheus text exposition
 * format (version 0.0.4). It defines the canonical metric names derived from
 * the §36 tracking list so every service registers the same names from day
 * one; a full client (e.g. prom-client) can replace the serializer later
 * without renaming metrics.
 *
 * Health wiring: {@link createHealthHandlers} builds the /health/live and
 * /health/ready payloads from the @enthusia/contracts health schemas,
 * sourcing model state from this package's gauges.
 */

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  /** Prometheus metric name, e.g. 'enthusia_prompt_tokens_total'. */
  name: string;
  /** Human-readable help text rendered in the exposition output. */
  help: string;
  kind: MetricKind;
  /** Allowed label names for this metric. */
  labelNames?: readonly string[];
  /** Histogram bucket upper bounds (le). Defaults to latency-friendly buckets. */
  buckets?: readonly number[];
}

/** Canonical metric names per MASTER-SPECIFICATION.md §36 tracking list. */
export const METRIC_NAMES = {
  /** Whether an inference model is currently loaded (0/1). */
  modelLoaded: 'enthusia_model_loaded',
  /** Resident model memory in bytes. */
  modelRamBytes: 'enthusia_model_ram_bytes',
  /** Prompt tokens processed (total). */
  promptTokens: 'enthusia_prompt_tokens_total',
  /** Generated tokens produced (total). */
  generationTokens: 'enthusia_generation_tokens_total',
  /** Inference latency in seconds (histogram). */
  inferenceLatency: 'enthusia_inference_latency_seconds',
  /** Depth of the inference work queue. */
  queueDepth: 'enthusia_inference_queue_depth',
  /** Requests currently being processed. */
  activeRequests: 'enthusia_active_requests',
  /** Tool calls (total). Labels: tool, status. */
  toolCalls: 'enthusia_tool_calls_total',
  /** Tool failures (total). Labels: tool. */
  toolFailures: 'enthusia_tool_failures_total',
  /** OpenAI escalation calls (total). */
  openaiEscalations: 'enthusia_openai_escalations_total',
  /** External API spend in USD (total). */
  externalCostUsd: 'enthusia_external_cost_usd_total',
  /** Knowledge retrieval operations (total). */
  retrievals: 'enthusia_retrievals_total',
  /** Stale-source blocks (total). */
  staleSourceBlocks: 'enthusia_stale_source_blocks_total',
  /** Memory writes/updates (total). */
  memoryUpdates: 'enthusia_memory_updates_total',
  /** Memory supersessions (total). */
  memorySupersessions: 'enthusia_memory_supersessions_total',
  /** Knowledge index lag in seconds. */
  indexLag: 'enthusia_index_lag_seconds',
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

const DEFAULT_LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;

type LabelValues = Record<string, string>;

function labelKey(labels: LabelValues): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ''}`)
    .join(',');
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: LabelValues): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? '')}"`);
  return `{${parts.join(',')}}`;
}

abstract class BaseMetric {
  readonly definition: MetricDefinition;

  constructor(definition: MetricDefinition) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(definition.name)) {
      throw new Error(`Invalid Prometheus metric name: ${definition.name}`);
    }
    for (const label of definition.labelNames ?? []) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) {
        throw new Error(`Invalid label name '${label}' on metric ${definition.name}`);
      }
    }
    this.definition = definition;
  }

  protected checkLabels(labels: LabelValues): void {
    const allowed = new Set(this.definition.labelNames ?? []);
    for (const key of Object.keys(labels)) {
      if (!allowed.has(key)) {
        throw new Error(`Metric ${this.definition.name} does not declare label '${key}'`);
      }
    }
  }

  abstract render(): string;
}

export class Counter extends BaseMetric {
  private readonly values = new Map<string, { labels: LabelValues; value: number }>();

  constructor(definition: Omit<MetricDefinition, 'kind'>) {
    super({ ...definition, kind: 'counter' });
  }

  /** Increment by a non-negative amount (default 1). */
  inc(labels: LabelValues = {}, amount = 1): void {
    if (amount < 0 || !Number.isFinite(amount)) {
      throw new Error('Counter increment must be a finite non-negative number');
    }
    this.checkLabels(labels);
    const key = labelKey(labels);
    const existing = this.values.get(key);
    this.values.set(key, { labels: { ...labels }, value: (existing?.value ?? 0) + amount });
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.definition.name} ${this.definition.help}`,
      `# TYPE ${this.definition.name} counter`,
    ];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.definition.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

export class Gauge extends BaseMetric {
  private readonly values = new Map<string, { labels: LabelValues; value: number }>();

  constructor(definition: Omit<MetricDefinition, 'kind'>) {
    super({ ...definition, kind: 'gauge' });
  }

  set(labels: LabelValues, value: number): void;
  set(value: number): void;
  set(labelsOrValue: LabelValues | number, value?: number): void {
    if (typeof labelsOrValue === 'number') {
      this.apply({}, labelsOrValue);
    } else {
      if (value === undefined || !Number.isFinite(value)) {
        throw new Error('Gauge value must be a finite number');
      }
      this.apply(labelsOrValue, value);
    }
  }

  private apply(labels: LabelValues, value: number): void {
    this.checkLabels(labels);
    this.values.set(labelKey(labels), { labels: { ...labels }, value });
  }

  inc(labels: LabelValues = {}, amount = 1): void {
    this.checkLabels(labels);
    const key = labelKey(labels);
    const existing = this.values.get(key);
    this.values.set(key, {
      labels: { ...labels },
      value: (existing?.value ?? 0) + amount,
    });
  }

  dec(labels: LabelValues = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  /** Current value for the given label set (0 when unset). */
  get(labels: LabelValues = {}): number {
    return this.values.get(labelKey(labels))?.value ?? 0;
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.definition.name} ${this.definition.help}`,
      `# TYPE ${this.definition.name} gauge`,
    ];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.definition.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

export class Histogram extends BaseMetric {
  private readonly bounds: readonly number[];
  private readonly series = new Map<
    string,
    { labels: LabelValues; buckets: number[]; sum: number; count: number }
  >();

  constructor(definition: Omit<MetricDefinition, 'kind'>) {
    super({ ...definition, kind: 'histogram' });
    this.bounds = [...(definition.buckets ?? DEFAULT_LATENCY_BUCKETS)].sort((a, b) => a - b);
  }

  observe(labels: LabelValues, value: number): void;
  observe(value: number): void;
  observe(labelsOrValue: LabelValues | number, value?: number): void {
    if (typeof labelsOrValue === 'number') {
      this.apply({}, labelsOrValue);
    } else {
      if (value === undefined) {
        throw new Error('Histogram observation requires a value');
      }
      this.apply(labelsOrValue, value);
    }
  }

  private apply(labels: LabelValues, value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Histogram observation must be a finite non-negative number');
    }
    this.checkLabels(labels);
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (entry === undefined) {
      entry = {
        labels: { ...labels },
        buckets: new Array(this.bounds.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, entry);
    }
    // Increment only the first bucket whose bound >= value; render() turns
    // per-bucket counts into cumulative exposition.
    for (let i = 0; i < this.bounds.length; i += 1) {
      const bound = this.bounds[i];
      if (bound !== undefined && value <= bound) {
        entry.buckets[i] = (entry.buckets[i] ?? 0) + 1;
        break;
      }
    }
    entry.sum += value;
    entry.count += 1;
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.definition.name} ${this.definition.help}`,
      `# TYPE ${this.definition.name} histogram`,
    ];
    for (const { labels, buckets, sum, count } of this.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < this.bounds.length; i += 1) {
        const bound = this.bounds[i];
        cumulative += buckets[i] ?? 0;
        lines.push(
          `${this.definition.name}_bucket${renderLabels({ ...labels, le: String(bound) })} ${cumulative}`,
        );
      }
      lines.push(
        `${this.definition.name}_bucket${renderLabels({ ...labels, le: '+Inf' })} ${count}`,
      );
      lines.push(`${this.definition.name}_sum${renderLabels(labels)} ${sum}`);
      lines.push(`${this.definition.name}_count${renderLabels(labels)} ${count}`);
    }
    return lines.join('\n');
  }
}

/**
 * Registry holding all metrics for one service process.
 * Render with `.render()` and serve the text as `GET /metrics`
 * with content type `text/plain; version=0.0.4`.
 */
export class MetricsRegistry {
  private readonly metrics = new Map<string, BaseMetric>();

  private register<T extends BaseMetric>(metric: T): T {
    if (this.metrics.has(metric.definition.name)) {
      throw new Error(`Metric already registered: ${metric.definition.name}`);
    }
    this.metrics.set(metric.definition.name, metric);
    return metric;
  }

  counter(definition: Omit<MetricDefinition, 'kind'>): Counter {
    return this.register(new Counter(definition));
  }

  gauge(definition: Omit<MetricDefinition, 'kind'>): Gauge {
    return this.register(new Gauge(definition));
  }

  histogram(definition: Omit<MetricDefinition, 'kind'>): Histogram {
    return this.register(new Histogram(definition));
  }

  /** Render every registered metric in Prometheus text exposition format. */
  render(): string {
    return [...this.metrics.values()].map((m) => m.render()).join('\n') + '\n';
  }
}

/** Dependency status in contracts-compatible shape (avoids importing contracts here). */
export interface HealthDependency {
  name: string;
  status: 'ok' | 'degraded' | 'down';
  latencyMs?: number;
  detail?: string;
}

export interface ServiceInfo {
  /** Startup version (§36). */
  version: string;
  /** Seconds since process start. */
  uptimeSeconds: number;
}

export interface HealthHandlers {
  /** Gauges backing the readiness payload — services update these at runtime. */
  gauges: {
    modelLoaded: Gauge;
    modelRamBytes: Gauge;
    queueDepth: Gauge;
    activeRequests: Gauge;
  };
  /** GET /health/live payload — process is alive. */
  liveness(service: ServiceInfo): {
    status: 'ok';
    version: string;
    uptimeSeconds: number;
  };
  /** GET /health/ready payload — can the service serve traffic? */
  readiness(
    service: ServiceInfo,
    dependencies: HealthDependency[],
  ): {
    status: 'ok' | 'degraded' | 'down';
    version: string;
    uptimeSeconds: number;
    dependencies: HealthDependency[];
    modelLoaded: boolean;
    modelRamBytes?: number;
    activeRequests?: number;
    queueDepth?: number;
  };
}

/**
 * Wire /health/live and /health/ready from the contracts schemas
 * (@enthusia/contracts health.ts), sourcing model state from the
 * service's metrics registry (§36: model loaded, model RAM, queue depth,
 * active requests, dependency status).
 */
export function createHealthHandlers(registry: MetricsRegistry): HealthHandlers {
  const modelLoaded = registry.gauge({
    name: METRIC_NAMES.modelLoaded,
    help: 'Whether an inference model is currently loaded (1) or not (0).',
  });
  const modelRamBytes = registry.gauge({
    name: METRIC_NAMES.modelRamBytes,
    help: 'Resident model memory in bytes.',
  });
  const queueDepth = registry.gauge({
    name: METRIC_NAMES.queueDepth,
    help: 'Depth of the inference work queue.',
  });
  const activeRequests = registry.gauge({
    name: METRIC_NAMES.activeRequests,
    help: 'Number of requests currently being processed.',
  });

  return {
    gauges: { modelLoaded, modelRamBytes, queueDepth, activeRequests },
    liveness: (service) => ({
      status: 'ok',
      version: service.version,
      uptimeSeconds: service.uptimeSeconds,
    }),
    readiness: (service, dependencies) => {
      const worst = dependencies.some((d) => d.status === 'down')
        ? 'down'
        : dependencies.some((d) => d.status === 'degraded')
          ? 'degraded'
          : 'ok';
      const payload: ReturnType<HealthHandlers['readiness']> = {
        status: worst,
        version: service.version,
        uptimeSeconds: service.uptimeSeconds,
        dependencies,
        modelLoaded: modelLoaded.get() === 1,
      };
      const ram = modelRamBytes.get();
      if (ram > 0) payload.modelRamBytes = ram;
      const active = activeRequests.get();
      if (active > 0) payload.activeRequests = active;
      const depth = queueDepth.get();
      if (depth > 0) payload.queueDepth = depth;
      return payload;
    },
  };
}

/**
 * Register the full §36 metric set on a registry, returning typed handles.
 * Services call this once at startup; individual workstreams then record
 * into the handles. Nothing here starts a server or scrapes anything.
 */
export function createServiceMetrics(registry: MetricsRegistry): {
  promptTokens: Counter;
  generationTokens: Counter;
  inferenceLatency: Histogram;
  toolCalls: Counter;
  toolFailures: Counter;
  openaiEscalations: Counter;
  externalCostUsd: Counter;
  retrievals: Counter;
  staleSourceBlocks: Counter;
  memoryUpdates: Counter;
  memorySupersessions: Counter;
  indexLag: Gauge;
} {
  return {
    promptTokens: registry.counter({
      name: METRIC_NAMES.promptTokens,
      help: 'Total prompt tokens processed.',
    }),
    generationTokens: registry.counter({
      name: METRIC_NAMES.generationTokens,
      help: 'Total generated tokens produced.',
    }),
    inferenceLatency: registry.histogram({
      name: METRIC_NAMES.inferenceLatency,
      help: 'Inference latency in seconds.',
    }),
    toolCalls: registry.counter({
      name: METRIC_NAMES.toolCalls,
      help: 'Total tool calls.',
      labelNames: ['tool', 'status'],
    }),
    toolFailures: registry.counter({
      name: METRIC_NAMES.toolFailures,
      help: 'Total tool failures.',
      labelNames: ['tool'],
    }),
    openaiEscalations: registry.counter({
      name: METRIC_NAMES.openaiEscalations,
      help: 'Total OpenAI escalation calls.',
    }),
    externalCostUsd: registry.counter({
      name: METRIC_NAMES.externalCostUsd,
      help: 'Total external API spend in USD.',
    }),
    retrievals: registry.counter({
      name: METRIC_NAMES.retrievals,
      help: 'Total knowledge retrieval operations.',
    }),
    staleSourceBlocks: registry.counter({
      name: METRIC_NAMES.staleSourceBlocks,
      help: 'Total stale-source blocks.',
    }),
    memoryUpdates: registry.counter({
      name: METRIC_NAMES.memoryUpdates,
      help: 'Total memory writes/updates.',
    }),
    memorySupersessions: registry.counter({
      name: METRIC_NAMES.memorySupersessions,
      help: 'Total memory supersessions.',
    }),
    indexLag: registry.gauge({
      name: METRIC_NAMES.indexLag,
      help: 'Knowledge index lag in seconds.',
    }),
  };
}
