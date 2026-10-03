import http from 'node:http';
import { ZodError, z } from 'zod';
import {
  EnthusiaError,
  ExternalServiceError,
  RateLimitError,
  TRACE_ID_HEADER,
  ValidationError,
  agentResponseSchema,
  chatRequestSchema,
  isValidTraceId,
  livenessResponseSchema,
  newTraceId,
  readinessResponseSchema,
  type Actor,
  type AgentResponse,
  type ChatRequest,
  type DependencyHealth,
  type HealthStatus,
  type ReadinessResponse,
} from '@enthusia/contracts';
import type { EnthusiaLogger } from '@enthusia/logging';
import type { GatewayConfig } from './config.js';
import {
  authenticateServiceKey,
  resolveVisibilityCeiling,
  validateActorSurface,
} from './auth.js';
import { GatewayRateLimiter, retryAfterSeconds } from './rate-limit.js';
import { withTimeout, type AgentContext } from './agent.js';
import { AgentRegistry, Router } from './router.js';

/**
 * @enthusia/ai-gateway — HTTP ingress.
 *
 * Spec: MASTER-SPECIFICATION.md §§36 (health/observability), 47 (failure
 * behavior), 48 (API contracts); WORKER-EXECUTION-PLAN.md §5 (W02).
 *
 * Endpoints:
 *  - POST /v1/chat    — ChatRequest in, AgentResponse out (mock agent, W02)
 *  - GET  /health/live  — liveness probe
 *  - GET  /health/ready — readiness probe (downstream agent reachability)
 *
 * Request pipeline for /v1/chat:
 *  ingress → trace ID → body/size → JSON → schema → service auth →
 *  actor/surface allowlist → visibility ceiling → message size →
 *  rate limits → route → agent (timeout) → typed response.
 */

export interface GatewayDeps {
  config: GatewayConfig;
  logger: EnthusiaLogger;
  router: Router;
  agents: AgentRegistry;
  /** Override for tests; defaults to config-derived limiter. */
  rateLimiter?: GatewayRateLimiter;
  /** Clock override for tests. */
  now?: () => number;
}

export interface RunningGateway {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

interface RequestContext {
  traceId?: string;
  statusCode: number;
  fields: Record<string, unknown>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function summarizeZod(error: ZodError): string {
  const parts = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  const joined = parts.join('; ');
  return joined.length > 500 ? `${joined.slice(0, 497)}...` : joined;
}

type ParsedChatRequest = z.infer<typeof chatRequestSchema>;

/**
 * Normalize zod-parsed output to the ChatRequest contract interface.
 *
 * Zod infers optional fields as explicitly `T | undefined`, which
 * exactOptionalPropertyTypes rejects against the hand-written contract
 * interfaces — so undefined-valued optionals are dropped rather than copied.
 */
function toChatRequest(parsed: ParsedChatRequest): ChatRequest {
  const actor: Actor = { id: parsed.actor.id, type: parsed.actor.type };
  if (parsed.actor.displayName !== undefined) {
    actor.displayName = parsed.actor.displayName;
  }
  if (parsed.actor.linkedUuid !== undefined) {
    actor.linkedUuid = parsed.actor.linkedUuid;
  }
  const request: ChatRequest = {
    surface: parsed.surface,
    actor,
    conversationId: parsed.conversationId,
    message: parsed.message,
    visibilityCeiling: parsed.visibilityCeiling,
  };
  if (parsed.context !== undefined) {
    request.context = parsed.context;
  }
  if (parsed.traceId !== undefined) {
    request.traceId = parsed.traceId;
  }
  return request;
}

/** Trace ID from the inbound header when valid, otherwise a fresh one. */
function traceIdFromHeaders(headers: http.IncomingHttpHeaders): string {
  const raw = headers[TRACE_ID_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate === 'string' && isValidTraceId(candidate)) {
    return candidate;
  }
  return newTraceId();
}

/** Prefer the header trace ID, then a valid body traceId, else generate. */
function resolveTraceId(headers: http.IncomingHttpHeaders, bodyTraceId: unknown): string {
  const raw = headers[TRACE_ID_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate === 'string' && isValidTraceId(candidate)) {
    return candidate;
  }
  if (typeof bodyTraceId === 'string' && isValidTraceId(bodyTraceId)) {
    return bodyTraceId;
  }
  return newTraceId();
}

function readBody(req: http.IncomingMessage, maxBytes: number, traceId: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        // Keep the socket alive long enough to return a structured 413.
        // The listener remains in flowing mode but ignores all further data.
        reject(
          new EnthusiaError('REQUEST_TOO_LARGE', 413, `Request body exceeds ${maxBytes} bytes.`, {
            traceId,
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function sendJson(
  res: http.ServerResponse,
  ctx: RequestContext,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  ctx.statusCode = statusCode;
  res.writeHead(statusCode, {
    ...JSON_HEADERS,
    ...(ctx.traceId !== undefined ? { [TRACE_ID_HEADER]: ctx.traceId } : {}),
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendError(
  res: http.ServerResponse,
  ctx: RequestContext,
  err: unknown,
  log: EnthusiaLogger,
): void {
  const traceId = ctx.traceId ?? newTraceId();
  ctx.traceId = traceId;
  let statusCode = 500;
  let payload: Record<string, unknown>;
  if (err instanceof EnthusiaError) {
    statusCode = err.statusCode;
    const json = err.toJSON();
    if (json['traceId'] === undefined) {
      json['traceId'] = traceId;
    }
    payload = { error: json };
  } else if (err instanceof ZodError) {
    // Defensive: a downstream agent returned a contract-invalid response.
    statusCode = 502;
    payload = {
      error: {
        code: 'BAD_AGENT_RESPONSE',
        statusCode: 502,
        message: 'Downstream agent returned an invalid response.',
        traceId,
      },
    };
  } else {
    statusCode = 500;
    payload = {
      error: {
        code: 'INTERNAL_ERROR',
        statusCode: 500,
        message: 'Internal server error.',
        traceId,
      },
    };
  }
  if (statusCode >= 500) {
    log.error({ err, statusCode }, 'request failed');
  } else {
    log.warn({ statusCode, code: (payload['error'] as Record<string, unknown>)['code'] }, 'request rejected');
  }
  sendJson(res, ctx, statusCode, payload);
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestContext,
  deps: Required<Pick<GatewayDeps, 'config' | 'logger' | 'router' | 'agents' | 'now'>> & {
    rateLimiter: GatewayRateLimiter;
  },
): Promise<void> {
  const { config, logger, router, agents, rateLimiter, now } = deps;
  const headerTraceId = traceIdFromHeaders(req.headers);

  // Authenticate before allocating/parsing the request body so unauthenticated
  // callers cannot consume gateway body-processing work.
  authenticateServiceKey(req.headers, config, headerTraceId);

  const raw = await readBody(req, config.maxBodyBytes, headerTraceId);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    ctx.traceId = headerTraceId;
    throw new EnthusiaError('INVALID_JSON', 400, 'Request body is not valid JSON.', {
      traceId: headerTraceId,
    });
  }

  const traceId = resolveTraceId(req.headers, (parsed as { traceId?: unknown } | null)?.traceId);
  ctx.traceId = traceId;
  const log = logger.withTraceId(traceId);

  const schemaResult = chatRequestSchema.safeParse(parsed);
  if (!schemaResult.success) {
    throw new ValidationError(`Invalid ChatRequest: ${summarizeZod(schemaResult.error)}`, { traceId });
  }
  const chatRequest = toChatRequest(schemaResult.data);

  validateActorSurface(chatRequest, config, traceId);
  const ceiling = resolveVisibilityCeiling(chatRequest.actor.type, chatRequest.visibilityCeiling, traceId);

  const messageBytes = Buffer.byteLength(chatRequest.message, 'utf8');
  if (messageBytes > config.maxMessageBytes) {
    throw new EnthusiaError(
      'MESSAGE_TOO_LARGE',
      413,
      `Message is ${messageBytes} bytes; limit is ${config.maxMessageBytes} bytes.`,
      { traceId },
    );
  }

  const rateKey = `${chatRequest.surface}:${chatRequest.actor.id}`;
  const decision = rateLimiter.check(rateKey, now());
  if (!decision.allowed) {
    const retryAfter = retryAfterSeconds(decision);
    ctx.fields['rateLimited'] = true;
    sendJson(
      res,
      ctx,
      429,
      {
        error: new RateLimitError(
          `Rate limit exceeded for '${rateKey}'. Retry after ${retryAfter}s.`,
          retryAfter,
          { traceId },
        ).toJSON(),
      },
      { 'retry-after': String(retryAfter) },
    );
    log.warn({ rateKey, retryAfter }, 'rate limit exceeded');
    return;
  }

  const route = router.route(chatRequest);
  const agent = agents.get(route.agentName);
  ctx.fields['surface'] = chatRequest.surface;
  ctx.fields['actorType'] = chatRequest.actor.type;
  ctx.fields['actorId'] = chatRequest.actor.id;
  ctx.fields['routeAgent'] = agent.name;
  ctx.fields['visibilityCeiling'] = ceiling;
  ctx.fields['messageBytes'] = messageBytes;
  log.info({ routeReason: route.reason }, 'routing chat request to downstream agent');

  const agentCtx: AgentContext = {
    traceId,
    visibilityCeiling: ceiling,
    deadlineMs: now() + config.agentTimeoutMs,
  };
  let agentResponse: AgentResponse;
  try {
    agentResponse = await withTimeout(agent.chat(chatRequest, agentCtx), agentCtx.deadlineMs, agent.name);
  } catch (err) {
    if (err instanceof EnthusiaError) {
      if (err.traceId === undefined) {
        throw new EnthusiaError(err.code, err.statusCode, err.message, { traceId, cause: err });
      }
      throw err;
    }
    throw new ExternalServiceError(agent.name, err instanceof Error ? err.message : String(err), {
      traceId,
    });
  }

  // Defensive: never emit a contract-invalid response, even from our own mock.
  const finalResponse: AgentResponse = { ...agentResponse, traceId };
  agentResponseSchema.parse(finalResponse);

  log.info({ agent: agent.name }, 'chat request completed');
  sendJson(res, ctx, 200, finalResponse);
}

async function handleLive(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestContext,
  deps: { config: GatewayConfig; now: () => number; startTimeMs: number },
): Promise<void> {
  const body = {
    status: 'ok' as const,
    version: deps.config.serviceVersion,
    uptimeSeconds: Math.max(0, Math.floor((deps.now() - deps.startTimeMs) / 1000)),
  };
  livenessResponseSchema.parse(body);
  sendJson(res, ctx, 200, body);
}

async function handleReady(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestContext,
  deps: {
    config: GatewayConfig;
    agents: AgentRegistry;
    now: () => number;
    startTimeMs: number;
    activeRequests: () => number;
  },
): Promise<void> {
  const dependencies: DependencyHealth[] = [];
  let overall: HealthStatus = 'ok';
  for (const name of deps.agents.names()) {
    const agent = deps.agents.get(name);
    const started = deps.now();
    try {
      const { latencyMs } = await withTimeout(
        agent.ping(),
        started + deps.config.readyProbeTimeoutMs,
        `${name}:ping`,
      );
      dependencies.push({ name, status: 'ok', latencyMs });
    } catch (err) {
      overall = 'down';
      const entry: DependencyHealth = {
        name,
        status: 'down',
        latencyMs: Math.max(0, deps.now() - started),
      };
      const detail = err instanceof Error ? err.message : String(err);
      dependencies.push({ ...entry, detail });
    }
  }
  const body: ReadinessResponse = {
    status: overall,
    version: deps.config.serviceVersion,
    uptimeSeconds: Math.max(0, Math.floor((deps.now() - deps.startTimeMs) / 1000)),
    dependencies,
    modelLoaded: false,
    activeRequests: deps.activeRequests(),
  };
  readinessResponseSchema.parse(body);
  sendJson(res, ctx, overall === 'down' ? 503 : 200, body);
}

/** Create the HTTP request handler (no socket binding; see startGateway). */
export function createRequestHandler(deps: GatewayDeps): http.RequestListener {
  const now = deps.now ?? Date.now;
  const rateLimiter = deps.rateLimiter ?? new GatewayRateLimiter(
    deps.config.rateLimitUserPerMin,
    deps.config.rateLimitGlobalPerMin,
  );
  const startTimeMs = now();
  let activeRequests = 0;
  const fullDeps = {
    config: deps.config,
    logger: deps.logger,
    router: deps.router,
    agents: deps.agents,
    rateLimiter,
    now,
  };

  const listener: http.RequestListener = (req, res) => {
    activeRequests += 1;
    const started = now();
    const ctx: RequestContext = { statusCode: 500, fields: {} };
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        if (req.method === 'POST' && path === '/v1/chat') {
          await handleChat(req, res, ctx, fullDeps);
        } else if (req.method === 'GET' && path === '/health/live') {
          await handleLive(req, res, ctx, { config: deps.config, now, startTimeMs });
        } else if (req.method === 'GET' && path === '/health/ready') {
          await handleReady(req, res, ctx, {
            config: deps.config,
            agents: deps.agents,
            now,
            startTimeMs,
            activeRequests: () => activeRequests,
          });
        } else if (
          (path === '/v1/chat' || path === '/health/live' || path === '/health/ready') &&
          req.method !== undefined
        ) {
          ctx.traceId = traceIdFromHeaders(req.headers);
          sendJson(res, ctx, 405, {
            error: {
              code: 'METHOD_NOT_ALLOWED',
              statusCode: 405,
              message: `Method '${req.method}' not allowed for '${path}'.`,
              traceId: ctx.traceId,
            },
          }, { allow: path === '/v1/chat' ? 'POST' : 'GET' });
        } else {
          ctx.traceId = traceIdFromHeaders(req.headers);
          sendJson(res, ctx, 404, {
            error: {
              code: 'NOT_FOUND',
              statusCode: 404,
              message: `No route for '${req.method ?? '?'} ${path}'.`,
              traceId: ctx.traceId,
            },
          });
        }
      } catch (err) {
        const log =
          ctx.traceId !== undefined ? deps.logger.withTraceId(ctx.traceId) : deps.logger;
        sendError(res, ctx, err, log);
      } finally {
        activeRequests -= 1;
        const log =
          ctx.traceId !== undefined ? deps.logger.withTraceId(ctx.traceId) : deps.logger;
        log.info(
          {
            method: req.method,
            path: req.url,
            statusCode: ctx.statusCode,
            durationMs: Math.max(0, now() - started),
            ...ctx.fields,
          },
          'request completed',
        );
      }
    })();
  };
  return listener;
}

/** Bind the gateway to a port (0 = ephemeral, for tests). */
export async function startGateway(deps: GatewayDeps, port?: number): Promise<RunningGateway> {
  const server = http.createServer(createRequestHandler(deps));
  const listenPort = port ?? deps.config.port;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('error', onError);
      reject(err);
    };
    server.on('error', onError);
    server.listen(listenPort, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const actualPort =
    typeof address === 'object' && address !== null ? address.port : listenPort;
  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }),
  };
}
