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
import type { StaleTicketDecisionService } from './stale-ticket.js';
import { handleStaleTicketDecisionHttp } from './stale-ticket-http.js';
import type { TicketEventIngress } from './ticket-event-ingress.js';

export interface AgentServiceDeps {
  config: AgentServiceConfig;
  logger: EnthusiaLogger;
  orchestrator: AgentOrchestrator;
  registry: ToolRegistry;
  inference: Pick<InferenceClient, 'getModels' | 'getMetrics'>;
  staleTicketDecision?: Pick<StaleTicketDecisionService, 'decide'>;
  ticketEventIngress?: Pick<TicketEventIngress, 'handle'>;
  now?: () => number;
}

export interface RunningAgentService {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

interface ServiceState {
  now: () => number;
  startedAt: number;
  activeRequests: number;
}

interface InferenceReadiness {
  status: HealthStatus;
  modelLoaded: boolean;
  dependency: DependencyHealth;
}

type ParsedChat =
  | { ok: true; request: ChatRequest }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    };

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

function uptimeSeconds(state: ServiceState): number {
  return Math.max(0, Math.floor((state.now() - state.startedAt) / 1000));
}

function handleLive(
  res: http.ServerResponse,
  deps: AgentServiceDeps,
  state: ServiceState,
): void {
  const body = {
    status: 'ok' as const,
    version: deps.config.serviceVersion,
    uptimeSeconds: uptimeSeconds(state),
  };
  livenessResponseSchema.parse(body);
  sendJson(res, 200, body);
}

async function probeInference(
  deps: AgentServiceDeps,
  state: ServiceState,
): Promise<InferenceReadiness> {
  const before = state.now();
  try {
    const models = await deps.inference.getModels();
    const modelLoaded = models.length > 0;
    return {
      status: modelLoaded ? 'ok' : 'degraded',
      modelLoaded,
      dependency: {
        name: 'local-inference',
        status: modelLoaded ? 'ok' : 'degraded',
        latencyMs: Math.max(0, state.now() - before),
        ...(modelLoaded
          ? {}
          : { detail: 'no model reported by inference runtime' }),
      },
    };
  } catch {
    return {
      status: 'down',
      modelLoaded: false,
      dependency: {
        name: 'local-inference',
        status: 'down',
        latencyMs: Math.max(0, state.now() - before),
        detail: 'inference runtime unavailable',
      },
    };
  }
}

async function handleReady(
  res: http.ServerResponse,
  deps: AgentServiceDeps,
  state: ServiceState,
): Promise<void> {
  const inference = await probeInference(deps, state);
  const dependencies: DependencyHealth[] = [
    inference.dependency,
    {
      name: 'tool-registry',
      status: 'ok',
      detail: String(deps.registry.size) + ' tools registered',
    },
  ];
  const body = {
    status: inference.status,
    version: deps.config.serviceVersion,
    uptimeSeconds: uptimeSeconds(state),
    dependencies,
    modelLoaded: inference.modelLoaded,
    activeRequests: state.activeRequests,
    queueDepth: deps.inference.getMetrics().queueDepth,
  };
  readinessResponseSchema.parse(body);
  sendJson(res, inference.status === 'down' ? 503 : 200, body);
}

function parseJsonBody(raw: Buffer): ParsedChat {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_JSON',
      message: 'request body is not valid JSON',
    };
  }
  const parsed = chatRequestSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_CHAT_REQUEST',
      message: 'request does not match ChatRequest',
    };
  }
  return { ok: true, request: parsed.data as ChatRequest };
}

async function parseChatRequest(
  req: http.IncomingMessage,
  maxBodyBytes: number,
): Promise<ParsedChat> {
  try {
    return parseJsonBody(await readBody(req, maxBodyBytes));
  } catch {
    return {
      ok: false,
      status: 413,
      code: 'REQUEST_TOO_LARGE',
      message: 'request body exceeds limit',
    };
  }
}

function sendParsedChatError(
  res: http.ServerResponse,
  parsed: Extract<ParsedChat, { ok: false }>,
): void {
  sendJson(res, parsed.status, {
    error: { code: parsed.code, message: parsed.message },
  });
}

async function executeChat(
  res: http.ServerResponse,
  deps: AgentServiceDeps,
  request: ChatRequest,
): Promise<void> {
  if (!validVisibility(request)) {
    sendJson(res, 403, {
      error: {
        code: 'VISIBILITY_DENIED',
        message: 'visibility ceiling exceeds actor grant',
      },
    });
    return;
  }

  const response = await deps.orchestrator.handleChat(request);
  agentResponseSchema.parse(response);
  sendJson(res, 200, response, response.traceId);
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentServiceDeps,
  state: ServiceState,
): Promise<void> {
  state.activeRequests += 1;
  try {
    const parsed = await parseChatRequest(req, deps.config.maxBodyBytes);
    if (!parsed.ok) {
      sendParsedChatError(res, parsed);
      return;
    }
    await executeChat(res, deps, parsed.request);
  } finally {
    state.activeRequests -= 1;
  }
}

async function handleTicketEventWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentServiceDeps,
  state: ServiceState,
): Promise<void> {
  if (deps.ticketEventIngress === undefined) {
    sendJson(res, 404, {
      error: { code: 'NOT_FOUND', message: 'route not found' },
    });
    return;
  }

  state.activeRequests += 1;
  try {
    let raw: Buffer;
    try {
      raw = await readBody(req, deps.config.maxBodyBytes);
    } catch {
      sendJson(res, 413, {
        error: {
          code: 'REQUEST_TOO_LARGE',
          message: 'request body exceeds limit',
        },
      });
      return;
    }
    const signature = req.headers['x-ticketbot-signature'];
    const result = await deps.ticketEventIngress.handle(
      raw,
      typeof signature === 'string' ? signature : undefined,
    );
    sendJson(res, result.status, result.body);
  } finally {
    state.activeRequests -= 1;
  }
}

async function handleProtectedRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: AgentServiceDeps,
  state: ServiceState,
): Promise<void> {
  if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
    sendJson(res, 200, capabilities(deps.registry));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/agent/chat') {
    await handleChat(req, res, deps, state);
    return;
  }
  if (
    req.method === 'POST' &&
    url.pathname === '/v1/ticket/stale-decision'
  ) {
    state.activeRequests += 1;
    try {
      await handleStaleTicketDecisionHttp(req, res, {
        maxBodyBytes: deps.config.maxBodyBytes,
        ...(deps.staleTicketDecision !== undefined
          ? { service: deps.staleTicketDecision }
          : {}),
      });
    } finally {
      state.activeRequests -= 1;
    }
    return;
  }
  sendJson(res, 404, {
    error: { code: 'NOT_FOUND', message: 'route not found' },
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentServiceDeps,
  state: ServiceState,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health/live') {
    handleLive(res, deps, state);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health/ready') {
    await handleReady(res, deps, state);
    return;
  }
  if (
    req.method === 'POST' &&
    url.pathname === '/v1/ticket/events'
  ) {
    await handleTicketEventWebhook(req, res, deps, state);
    return;
  }
  if (!authenticate(req, deps.config)) {
    sendJson(res, 401, {
      error: {
        code: 'UNAUTHORIZED',
        message: 'service authentication required',
      },
    });
    return;
  }
  await handleProtectedRoute(req, res, url, deps, state);
}

function handleUnhandledError(
  error: unknown,
  res: http.ServerResponse,
  logger: EnthusiaLogger,
): void {
  const traceId = newTraceId();
  logger.error({ error, traceId }, 'agent service request failed');
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(
    res,
    500,
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'internal agent service error',
        traceId,
      },
    },
    traceId,
  );
}

function createRequestHandler(
  deps: AgentServiceDeps,
  state: ServiceState,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    void handleRequest(req, res, deps, state).catch((error: unknown) => {
      handleUnhandledError(error, res, deps.logger);
    });
  };
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
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
    server.listen(port);
  });
}

function boundPort(server: http.Server, fallback: number): number {
  const address = server.address();
  return typeof address === 'object' && address !== null
    ? address.port
    : fallback;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

export async function startAgentService(
  deps: AgentServiceDeps,
): Promise<RunningAgentService> {
  const now = deps.now ?? Date.now;
  const state: ServiceState = {
    now,
    startedAt: now(),
    activeRequests: 0,
  };
  const server = http.createServer(createRequestHandler(deps, state));
  await listen(server, deps.config.port);

  return {
    server,
    port: boundPort(server, deps.config.port),
    close: () => closeServer(server),
  };
}
