import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  TRACE_ID_HEADER,
  Visibility,
  agentResponseSchema,
  chatRequestSchema,
  livenessResponseSchema,
  newTraceId,
  readinessResponseSchema,
  visibilityRank,
  type ChatRequest,
  type DependencyHealth,
  type HealthStatus,
} from '@enthusia/contracts';
import type { AgentOrchestrator, ToolRegistry } from '@enthusia/agent-core';
import type { InferenceClient } from '@enthusia/inference-adapter';
import type { EnthusiaLogger } from '@enthusia/logging';
import type { AgentServiceConfig } from './config.js';

export interface AgentServiceDeps {
  config: AgentServiceConfig;
  logger: EnthusiaLogger;
  orchestrator: AgentOrchestrator;
  registry: ToolRegistry;
  inference: Pick<InferenceClient, 'getModels' | 'getMetrics'>;
  now?: () => number;
}

export interface RunningAgentService {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authenticate(
  req: http.IncomingMessage,
  config: AgentServiceConfig,
): boolean {
  if (config.apiKeys.length === 0) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const candidate = header.slice('Bearer '.length);
  return config.apiKeys.some((key) => equalSecret(candidate, key));
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  traceId?: string,
): void {
  res.writeHead(statusCode, {
    ...JSON_HEADERS,
    ...(traceId !== undefined ? { [TRACE_ID_HEADER]: traceId } : {}),
  });
  res.end(JSON.stringify(body));
}

function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

function actorCeiling(type: ChatRequest['actor']['type']): Visibility {
  switch (type) {
    case 'player':
      return Visibility.PLAYER_SELF;
    case 'staff':
      return Visibility.STAFF;
    case 'system':
      return Visibility.SYSTEM_INTERNAL;
    case 'unknown':
      return Visibility.PUBLIC;
  }
}

function validVisibility(request: ChatRequest): boolean {
  return visibilityRank(request.visibilityCeiling) <=
    visibilityRank(actorCeiling(request.actor.type));
}

function capabilities(registry: ToolRegistry): Record<string, unknown> {
  const tools = registry.list().map((tool) => tool.name).sort();
  return {
    reasoner: 'local-inference',
    registeredTools: tools,
    toolCount: tools.length,
  };
}

export async function startAgentService(
  deps: AgentServiceDeps,
): Promise<RunningAgentService> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let activeRequests = 0;

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health/live') {
        const body = {
          status: 'ok' as const,
          version: deps.config.serviceVersion,
          uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)),
        };
        livenessResponseSchema.parse(body);
        sendJson(res, 200, body);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health/ready') {
        const dependencies: DependencyHealth[] = [];
        let status: HealthStatus = 'ok';
        let modelLoaded = false;
        const before = now();
        try {
          const models = await deps.inference.getModels();
          modelLoaded = models.length > 0;
          dependencies.push({
            name: 'local-inference',
            status: modelLoaded ? 'ok' : 'degraded',
            latencyMs: Math.max(0, now() - before),
            ...(modelLoaded ? {} : { detail: 'no model reported by inference runtime' }),
          });
          if (!modelLoaded) status = 'degraded';
        } catch {
          status = 'down';
          dependencies.push({
            name: 'local-inference',
            status: 'down',
            latencyMs: Math.max(0, now() - before),
            detail: 'inference runtime unavailable',
          });
        }

        dependencies.push({
          name: 'tool-registry',
          status: 'ok',
          detail: String(deps.registry.size) + ' tools registered',
        });

        const body = {
          status,
          version: deps.config.serviceVersion,
          uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)),
          dependencies,
          modelLoaded,
          activeRequests,
          queueDepth: deps.inference.getMetrics().queueDepth,
        };
        readinessResponseSchema.parse(body);
        sendJson(res, status === 'down' ? 503 : 200, body);
        return;
      }

      if (!authenticate(req, deps.config)) {
        sendJson(res, 401, {
          error: { code: 'UNAUTHORIZED', message: 'service authentication required' },
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
        sendJson(res, 200, capabilities(deps.registry));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/agent/chat') {
        activeRequests += 1;
        try {
          let raw: Buffer;
          try {
            raw = await readBody(req, deps.config.maxBodyBytes);
          } catch {
            sendJson(res, 413, {
              error: { code: 'REQUEST_TOO_LARGE', message: 'request body exceeds limit' },
            });
            return;
          }

          let json: unknown;
          try {
            json = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, {
              error: { code: 'INVALID_JSON', message: 'request body is not valid JSON' },
            });
            return;
          }

          const parsed = chatRequestSchema.safeParse(json);
          if (!parsed.success) {
            sendJson(res, 400, {
              error: { code: 'INVALID_CHAT_REQUEST', message: 'request does not match ChatRequest' },
            });
            return;
          }

          const request = parsed.data as ChatRequest;
          if (!validVisibility(request)) {
            sendJson(res, 403, {
              error: { code: 'VISIBILITY_DENIED', message: 'visibility ceiling exceeds actor grant' },
            });
            return;
          }

          const response = await deps.orchestrator.handleChat(request);
          agentResponseSchema.parse(response);
          sendJson(res, 200, response, response.traceId);
          return;
        } finally {
          activeRequests -= 1;
        }
      }

      sendJson(res, 404, {
        error: { code: 'NOT_FOUND', message: 'route not found' },
      });
    })().catch((error: unknown) => {
      const traceId = newTraceId();
      deps.logger.error({ error, traceId }, 'agent service request failed');
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'internal agent service error',
            traceId,
          },
        }, traceId);
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(deps.config.port);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null
    ? address.port
    : deps.config.port;

  return {
    server,
    port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}
