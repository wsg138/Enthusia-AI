import {
  ExternalServiceError,
  TRACE_ID_HEADER,
  agentResponseSchema,
  readinessResponseSchema,
  type AgentResponse,
  type ChatRequest,
} from '@enthusia/contracts';
import type { Agent, AgentContext } from './agent.js';

export interface HttpAgentConfig {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class HttpAgent implements Agent {
  readonly name = 'enthusia-agent';
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpAgentConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl =
      config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async ping(): Promise<{ latencyMs: number }> {
    const started = Date.now();
    const response = await this.request('/health/ready', {
      method: 'GET',
    });
    const body: unknown = await response.json();
    const parsed = readinessResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.status === 'down') {
      throw new ExternalServiceError(
        this.name,
        'agent readiness probe failed',
      );
    }
    return { latencyMs: Date.now() - started };
  }

  async chat(
    request: ChatRequest,
    ctx: AgentContext,
  ): Promise<AgentResponse> {
    const effectiveRequest: ChatRequest = {
      ...request,
      visibilityCeiling: ctx.visibilityCeiling,
      traceId: ctx.traceId,
    };
    const response = await this.request(
      '/v1/agent/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(effectiveRequest),
      },
      ctx,
    );

    if (!response.ok) {
      throw new ExternalServiceError(
        this.name,
        'agent service rejected the chat request',
        { traceId: ctx.traceId },
      );
    }

    const json: unknown = await response.json();
    const parsed = agentResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ExternalServiceError(
        this.name,
        'agent service returned an invalid response',
        { traceId: ctx.traceId },
      );
    }
    return json as AgentResponse;
  }

  private async request(
    path: string,
    init: RequestInit,
    ctx?: AgentContext,
  ): Promise<Response> {
    const controller = new AbortController();
    const remaining =
      ctx === undefined
        ? 5000
        : Math.max(1, ctx.deadlineMs - Date.now());
    const timer = setTimeout(() => controller.abort(), remaining);
    timer.unref?.();

    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (this.apiKey !== undefined) {
      headers.set('authorization', 'Bearer ' + this.apiKey);
    }
    if (ctx !== undefined) {
      headers.set(TRACE_ID_HEADER, ctx.traceId);
    }

    try {
      return await this.fetchImpl(this.baseUrl + path, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      throw new ExternalServiceError(
        this.name,
        error instanceof Error && error.name === 'AbortError'
          ? 'agent service request timed out'
          : 'agent service is unreachable',
        ctx === undefined ? {} : { traceId: ctx.traceId },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
