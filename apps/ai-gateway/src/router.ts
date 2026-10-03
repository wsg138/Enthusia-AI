import { NotFoundError, type ChatRequest } from '@enthusia/contracts';
import type { Agent } from './agent.js';

/**
 * @enthusia/ai-gateway — conversation routing.
 *
 * Spec: WORKER-EXECUTION-PLAN.md §5 (W02 owns conversation routing).
 *
 * W02 routes every request to the mock agent. Surface-aware routing
 * (per-surface agents, staff escalation paths) is future work owned with the
 * agent orchestrator (W12); the decision point is explicit here so it can be
 * extended without touching ingress code.
 */

/** Which downstream agent should handle the request, and why. */
export interface RouteDecision {
  agentName: string;
  reason: string;
}

export class Router {
  route(request: ChatRequest): RouteDecision {
    // W02: single mock agent for every surface. The surface is recorded in
    // the decision so routing policy can branch on it later.
    return {
      agentName: 'mock-agent',
      reason: `default route for surface '${request.surface}'`,
    };
  }
}

/** Registry of downstream agents available to the router. */
export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  register(agent: Agent): void {
    this.agents.set(agent.name, agent);
  }

  get(name: string): Agent {
    const agent = this.agents.get(name);
    if (agent === undefined) {
      throw new NotFoundError(`No downstream agent registered under name '${name}'.`);
    }
    return agent;
  }

  names(): string[] {
    return [...this.agents.keys()];
  }
}
