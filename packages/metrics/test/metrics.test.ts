import { describe, expect, it } from 'vitest';
import {
  livenessResponseSchema,
  readinessResponseSchema,
} from '../../contracts/src/index.js';
import {
  createHealthHandlers,
  createServiceMetrics,
  Counter,
  Gauge,
  Histogram,
  METRIC_NAMES,
  MetricsRegistry,
} from '../src/index.js';

describe('METRIC_NAMES', () => {
  it('covers every §36 tracking item with the enthusiasm_ prefix', () => {
    const required = [
      'modelLoaded',
      'modelRamBytes',
      'promptTokens',
      'generationTokens',
      'inferenceLatency',
      'queueDepth',
      'activeRequests',
      'toolCalls',
      'toolFailures',
      'openaiEscalations',
      'externalCostUsd',
      'retrievals',
      'staleSourceBlocks',
      'memoryUpdates',
      'memorySupersessions',
      'indexLag',
    ] as const;
    for (const key of required) {
      expect(METRIC_NAMES[key].startsWith('enthusia_')).toBe(true);
    }
  });
});

describe('Counter', () => {
  it('increments and renders exposition format', () => {
    const registry = new MetricsRegistry();
    const c = registry.counter({
      name: 'enthusia_test_total',
      help: 'Test counter.',
      labelNames: ['tool'],
    });
    c.inc();
    c.inc({ tool: 'github' }, 4);
    const out = registry.render();
    expect(out).toContain('# HELP enthusia_test_total Test counter.');
    expect(out).toContain('# TYPE enthusia_test_total counter');
    expect(out).toContain('enthusia_test_total 1');
    expect(out).toContain('enthusia_test_total{tool="github"} 4');
  });

  it('supports declared labels and rejects undeclared ones', () => {
    const c = new Counter({
      name: 'enthusia_labeled_total',
      help: 'h',
      labelNames: ['tool', 'status'],
    });
    c.inc({ tool: 'github', status: 'ok' }, 2);
    expect(() => c.inc({ nope: 'x' })).toThrow(/does not declare label/);
    const out = c.render();
    expect(out).toContain('enthusia_labeled_total{status="ok",tool="github"} 2');
  });

  it('escapes label values', () => {
    const c = new Counter({ name: 'enthusia_esc_total', help: 'h', labelNames: ['q'] });
    c.inc({ q: 'a"b\\c\nd' });
    expect(c.render()).toContain('q="a\\"b\\\\c\\nd"');
  });

  it('rejects negative increments', () => {
    const c = new Counter({ name: 'enthusia_neg_total', help: 'h' });
    expect(() => c.inc({}, -1)).toThrow(/non-negative/);
  });

  it('rejects invalid metric names', () => {
    expect(() => new Counter({ name: '9bad', help: 'h' })).toThrow(/Invalid Prometheus metric name/);
  });
});

describe('Gauge', () => {
  it('sets, incs, decs, and reads values', () => {
    const g = new Gauge({ name: 'enthusia_gauge', help: 'h', labelNames: ['region'] });
    g.set(3);
    expect(g.get()).toBe(3);
    g.inc();
    expect(g.get()).toBe(4);
    g.dec({}, 2);
    expect(g.get()).toBe(2);
    g.set({ region: 'eu' }, 7);
    expect(g.get({ region: 'eu' })).toBe(7);
    const out = g.render();
    expect(out).toContain('enthusia_gauge 2');
    expect(out).toContain('enthusia_gauge{region="eu"} 7');
  });
});

describe('Histogram', () => {
  it('buckets observations cumulatively with +Inf, sum, count', () => {
    const h = new Histogram({
      name: 'enthusia_latency_seconds',
      help: 'h',
      buckets: [0.1, 0.5],
    });
    h.observe(0.05);
    h.observe(0.3);
    h.observe(2);
    const out = h.render();
    expect(out).toContain('enthusia_latency_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('enthusia_latency_seconds_bucket{le="0.5"} 2');
    expect(out).toContain('enthusia_latency_seconds_bucket{le="+Inf"} 3');
    expect(out).toContain('enthusia_latency_seconds_count 3');
    expect(out).toContain('enthusia_latency_seconds_sum');
  });

  it('rejects negative observations', () => {
    const h = new Histogram({ name: 'enthusia_hist', help: 'h' });
    expect(() => h.observe(-1)).toThrow(/non-negative/);
  });
});

describe('MetricsRegistry', () => {
  it('rejects duplicate metric registration', () => {
    const registry = new MetricsRegistry();
    registry.counter({ name: 'enthusia_dup_total', help: 'h' });
    expect(() => registry.counter({ name: 'enthusia_dup_total', help: 'h' })).toThrow(
      /already registered/,
    );
  });
});

describe('createServiceMetrics', () => {
  it('registers the full §36 set with the canonical names', () => {
    const registry = new MetricsRegistry();
    const m = createServiceMetrics(registry);
    m.promptTokens.inc({}, 10);
    m.generationTokens.inc({}, 5);
    m.inferenceLatency.observe(0.2);
    m.toolCalls.inc({ tool: 'github', status: 'ok' });
    m.toolFailures.inc({ tool: 'sftp' });
    m.openaiEscalations.inc();
    m.externalCostUsd.inc({}, 0.02);
    m.retrievals.inc();
    m.staleSourceBlocks.inc();
    m.memoryUpdates.inc();
    m.memorySupersessions.inc();
    m.indexLag.set(12);
    const out = registry.render();
    for (const name of Object.values(METRIC_NAMES)) {
      if (
        name === METRIC_NAMES.modelLoaded ||
        name === METRIC_NAMES.modelRamBytes ||
        name === METRIC_NAMES.queueDepth ||
        name === METRIC_NAMES.activeRequests
      ) {
        continue; // registered by createHealthHandlers, not createServiceMetrics
      }
      expect(out).toContain(name);
    }
    expect(out).toContain('enthusia_prompt_tokens_total 10');
  });
});

describe('health handler contract conformance', () => {
  it('produces payloads that validate against @enthusia/contracts schemas', () => {
    const registry = new MetricsRegistry();
    const health = createHealthHandlers(registry);
    const svc = { version: '0.1.0', uptimeSeconds: 9 };
    expect(() => livenessResponseSchema.parse(health.liveness(svc))).not.toThrow();
    const ready = health.readiness(svc, [{ name: 'llama.cpp', status: 'ok', latencyMs: 3 }]);
    expect(() => readinessResponseSchema.parse(ready)).not.toThrow();
  });
});

describe('createHealthHandlers', () => {
  it('builds liveness and readiness payloads from gauges', () => {
    const registry = new MetricsRegistry();
    const health = createHealthHandlers(registry);
    const live = health.liveness({ version: '0.1.0', uptimeSeconds: 42 });
    expect(live).toEqual({ status: 'ok', version: '0.1.0', uptimeSeconds: 42 });

    const ready = health.readiness(
      { version: '0.1.0', uptimeSeconds: 42 },
      [{ name: 'postgres', status: 'ok' }],
    );
    expect(ready.status).toBe('ok');
    expect(ready.modelLoaded).toBe(false);
    expect(ready.modelRamBytes).toBeUndefined();

    // Simulate a model load via the exposed gauges.
    health.gauges.modelLoaded.set(1);
    health.gauges.modelRamBytes.set(28 * 1024 ** 3);
    health.gauges.queueDepth.set(2);
    health.gauges.activeRequests.set(3);
    const readyLoaded = health.readiness(
      { version: '0.1.0', uptimeSeconds: 43 },
      [{ name: 'postgres', status: 'ok' }],
    );
    expect(readyLoaded.modelLoaded).toBe(true);
    expect(readyLoaded.modelRamBytes).toBe(28 * 1024 ** 3);
    expect(readyLoaded.queueDepth).toBe(2);
    expect(readyLoaded.activeRequests).toBe(3);
  });

  it('derives worst-case readiness from dependencies', () => {
    const registry = new MetricsRegistry();
    const health = createHealthHandlers(registry);
    const svc = { version: '0.1.0', uptimeSeconds: 1 };
    expect(
      health.readiness(svc, [{ name: 'qdrant', status: 'degraded' }]).status,
    ).toBe('degraded');
    expect(health.readiness(svc, [{ name: 'postgres', status: 'down' }]).status).toBe('down');
  });

  it('throws on duplicate registration when called twice on one registry', () => {
    const registry = new MetricsRegistry();
    createHealthHandlers(registry);
    expect(() => createHealthHandlers(registry)).toThrow(/already registered/);
  });
});
