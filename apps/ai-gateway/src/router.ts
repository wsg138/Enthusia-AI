import { NotFoundError, type ChatRequest } from '@enthusia/contracts';
import type { Agent } from './agent.js';

export interface RouteDecision {
  agentName: string;
  reason: string;
}

export class Router {
  constructor(private readonly defaultAgentName = 'mock-agent') {}

  route(request: ChatRequest): RouteDecision {
    return {
      agentName: this.defaultAgentName,
      reason: `default route for surface '${request.surface}'`,
    };
  }
}

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  register(agent: Agent): void {
    this.agents.set(agent.name, agent);
  }

  get(name: string): Agent {
    const agent = this.agents.get(name);
    if (agent === undefined) {
      throw new NotFoundError(
        `No downstream agent registered under name '${name}'.`,
      );
    }
    return agent;
  }

  names(): string[] {
    return [...this.agents.keys()];
  }
}
