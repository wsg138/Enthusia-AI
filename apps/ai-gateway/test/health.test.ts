import { afterEach, describe, expect, it } from 'vitest';
import {
  TRACE_ID_HEADER,
  isValidTraceId,
  livenessResponseSchema,
  readinessResponseSchema,
} from '@enthusia/contracts';
import { startTestGateway, testFetch, type TestGateway } from './helpers.js';

let gateway: TestGateway | undefined;

afterEach(async () => {
  await gateway?.running.close();
  gateway = undefined;
});

describe('GET /health/live', () => {
  it('returns a contract-valid liveness response', async () => {
    gateway = await startTestGateway();
    const res = await testFetch(`${gateway.baseUrl}/health/live`);
    expect(res.status).toBe(200);
    const body = livenessResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ status: 'ok', version: '0.1.0' });
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /health/ready', () => {
  it('reports ok while the mock agent is reachable', async () => {
    gateway = await startTestGateway();
    const res = await testFetch(`${gateway.baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    const body = readinessResponseSchema.parse(await res.json());
    expect(body.status).toBe('ok');
    expect(body.modelLoaded).toBe(false);
    expect(body.dependencies).toHaveLength(1);
    const dep = body.dependencies[0];
    expect(dep).toBeDefined();
    expect(dep).toMatchObject({ name: 'mock-agent', status: 'ok' });
    expect(dep?.latencyMs).toEqual(expect.any(Number));
  });

  it('reports down with HTTP 503 when the downstream agent is unreachable', async () => {
    gateway = await startTestGateway();
    gateway.mock.setDown(true);
    const res = await testFetch(`${gateway.baseUrl}/health/ready`);
    expect(res.status).toBe(503);
    const body = readinessResponseSchema.parse(await res.json());
    expect(body.status).toBe('down');
    const dep = body.dependencies[0];
    expect(dep).toMatchObject({ name: 'mock-agent', status: 'down' });
  });
});

describe('unknown routes and methods', () => {
  it('returns 404 JSON with a trace ID for unknown paths', async () => {
    gateway = await startTestGateway();
    const res = await testFetch(`${gateway.baseUrl}/v1/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; traceId: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(isValidTraceId(body.error.traceId)).toBe(true);
    expect(res.headers.get(TRACE_ID_HEADER)).toBe(body.error.traceId);
  });

  it('returns 405 for wrong methods on known paths', async () => {
    gateway = await startTestGateway();
    const res = await testFetch(`${gateway.baseUrl}/v1/chat`, { method: 'GET' });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });
});
