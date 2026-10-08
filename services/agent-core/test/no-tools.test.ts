import { describe, expect, it } from 'vitest';
import { AgentOrchestrator } from '../src/orchestrator.js';
import { MockReasoner, makeRequest, mockRegistry, simpleClassification } from './mocks.js';

describe('zero-tool agent behavior', () => {
  it('answers a capability question without inventing a live source', async () => {
    const reasoner = new MockReasoner({
      classification: simpleClassification({ claims: ['the user is asking about available actions'] }),
      plan: [],
      decisions: [],
    });
    const orchestrator = new AgentOrchestrator({ reasoner, registry: mockRegistry([]).registry });
    const response = await orchestrator.handleChat(makeRequest('What can you do?'));
    expect(response.text).toContain('connected, verified sources');
    expect(response.escalation).toBeNull();
    expect(reasoner.snapshots).toHaveLength(0);
  });

  it('does not invent server details when there is no evidence plan', async () => {
    const reasoner = new MockReasoner({
      classification: simpleClassification({ claims: ['server IP'] }),
      plan: [],
      decisions: [],
    });
    const orchestrator = new AgentOrchestrator({ reasoner, registry: mockRegistry([]).registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));
    expect(response.text).toContain('could not verify');
    expect(response.sources).toEqual([]);
    expect(response.escalation).toBeNull();
    expect(reasoner.snapshots).toHaveLength(0);
  });

  it('reports unexpected errors internally without claiming it notified staff', async () => {
    const reasoner = new MockReasoner({
      classification: simpleClassification(),
      plan: [],
      decisions: [],
    });
    reasoner.classifyIntent = async () => { throw new Error('synthetic model failed'); };
    const failures: unknown[] = [];
    const orchestrator = new AgentOrchestrator({
      reasoner,
      registry: mockRegistry([]).registry,
      onUnhandledError: (error) => failures.push(error),
    });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));
    expect(response.text).toContain('could not finish that request');
    expect(response.text).not.toContain('staff review');
    expect(response.escalation).toBeNull();
    expect(failures).toHaveLength(1);
  });
});
