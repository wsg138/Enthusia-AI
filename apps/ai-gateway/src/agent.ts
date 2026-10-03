import {
  EnthusiaError,
  Visibility,
  agentResponseSchema,
  type AgentResponse,
  type ChatRequest,
} from '@enthusia/contracts';

/**
 * @enthusia/ai-gateway — downstream agent abstraction and the W02 mock agent.
 *
 * Spec: WORKER-EXECUTION-PLAN.md §5 (W02 routes to a mock agent initially;
 * model-specific logic is W03/W12 and MUST NOT live here).
 *
 * The gateway depends only on the `Agent` interface. `MockAgent` is the
 * initial (and currently only) implementation: it returns a deterministic,
 * typed AgentResponse so surfaces and the gateway boundary can be built and
 * tested before any model exists.
 */

/** Context the gateway propagates to the downstream agent per request. */
export interface AgentContext {
  /** Trace ID for the request (propagated via x-enthusia-trace-id). */
  traceId: string;
  /** Effective visibility ceiling after gateway policy (auth.ts). */
  visibilityCeiling: Visibility;
  /** Absolute deadline (Date.now() ms) for the agent call. */
  deadlineMs: number;
}

/** Downstream agent contract. W03/W12 provide real implementations. */
export interface Agent {
  readonly name: string;
  /** Liveness probe used by /health/ready. Rejects when unreachable. */
  ping(): Promise<{ latencyMs: number }>;
  chat(request: ChatRequest, ctx: AgentContext): Promise<AgentResponse>;
}

/**
 * Deterministic mock agent: echoes the request as a typed AgentResponse.
 * Contains NO model logic — it exists so the gateway boundary, routing,
 * auth, rate limits, and health probes are testable end to end.
 */
export class MockAgent implements Agent {
  readonly name = 'mock-agent';
  private down = false;

  /** Test hook: simulate the downstream agent being unreachable. */
  setDown(down: boolean): void {
    this.down = down;
  }

  async ping(): Promise<{ latencyMs: number }> {
    const started = Date.now();
    if (this.down) {
      throw new Error('mock-agent is down (simulated)');
    }
    return { latencyMs: Date.now() - started };
  }

  async chat(request: ChatRequest, ctx: AgentContext): Promise<AgentResponse> {
    if (this.down) {
      throw new Error('mock-agent is down (simulated)');
    }
    const response: AgentResponse = {
      text:
        `[mock-agent] surface=${request.surface} ` +
        `actor=${request.actor.type}:${request.actor.id} ` +
        `ceiling=${ctx.visibilityCeiling} :: ${request.message}`,
      actions: [],
      sources: [],
      memoryUpdates: [],
      escalation: null,
      traceId: ctx.traceId,
    };
    // Defensive: the gateway must only ever emit contract-valid responses.
    agentResponseSchema.parse(response);
    return response;
  }
}

/**
 * Race a promise against a deadline. Rejects with EnthusiaError
 * (504 AGENT_TIMEOUT) when the deadline passes first.
 */
export function withTimeout<T>(promise: Promise<T>, deadlineMs: number, label: string): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    return Promise.reject(
      new EnthusiaError('AGENT_TIMEOUT', 504, `Downstream agent '${label}' timed out immediately.`),
    );
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new EnthusiaError(
          'AGENT_TIMEOUT',
          504,
          `Downstream agent '${label}' timed out after ${Math.max(0, deadlineMs - Date.now())}ms.`,
        ),
      );
    }, remaining);
    timer.unref?.();
  });
  // A downstream agent may settle AFTER the race (e.g. a hung agent that
  // eventually throws). Without a handler on the original promise, that late
  // settlement surfaces as an unhandled rejection and crashes the process.
  promise.then(
    () => {},
    () => {},
  );
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}
