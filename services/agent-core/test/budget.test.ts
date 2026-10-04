/**
 * @enthusia/agent-core — budget enforcement tests (W12).
 *
 * Spec §78 (tool budgets) and §15.3 (bounded curiosity): the loop must
 * terminate even when the reasoner keeps asking for more tool calls, and
 * auto-expansion must stay within the same budget.
 */
import { describe, expect, it } from 'vitest';
import { AgentOrchestrator, runInvestigation } from '../src/index.js';
import { BudgetTracker, policyForRequestClass } from '../src/budget.js';
import {
  callTool,
  docsSearchMeta,
  FINISH,
  knowledgeSearchMeta,
  makeRequest,
  MockReasoner,
  MockTool,
  mockRegistry,
  okResult,
  simpleClassification,
} from './mocks.js';

describe('tool budgets', () => {
  it('terminates a runaway reasoner: simple budget caps at 3 tool calls', async () => {
    const knowledge = new MockTool(knowledgeSearchMeta, () =>
      okResult('knowledge.search', 'knowledge-indexer', { value: 'play.enthusia.gg' }),
    );
    const { registry } = mockRegistry([knowledge]);
    // The reasoner never stops asking for more tool calls.
    const reasoner = new MockReasoner({
      classification: simpleClassification(),
      plan: [
        {
          claim: 'server IP',
          candidateTools: ['knowledge.search'],
          verificationTier: 'B',
          privacySensitive: false,
        },
      ],
      decisions: Array.from({ length: 50 }, () =>
        callTool('knowledge.search', 'server IP'),
      ),
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));

    // The loop terminated instead of running forever.
    expect(knowledge.callCount).toBe(3);
    expect(response.text).toContain('play.enthusia.gg');
    // Budget exhaustion is surfaced honestly.
    expect(response.text).toContain('tool budget');
  });

  it('runInvestigation reports budget_exhausted termination', async () => {
    const knowledge = new MockTool(knowledgeSearchMeta, () =>
      okResult('knowledge.search', 'knowledge-indexer', { value: 'play.enthusia.gg' }),
    );
    const { registry } = mockRegistry([knowledge]);
    const reasoner = new MockReasoner({
      classification: simpleClassification(),
      plan: [
        {
          claim: 'server IP',
          candidateTools: ['knowledge.search'],
          verificationTier: 'B',
          privacySensitive: false,
        },
      ],
      decisions: Array.from({ length: 50 }, () =>
        callTool('knowledge.search', 'server IP'),
      ),
    });
    const policy = policyForRequestClass('simple');
    const budget = new BudgetTracker(policy);
    const request = { ...makeRequest('What is the server IP?'), traceId: 't-budget-1' };

    const outcome = await runInvestigation(
      {
        request,
        classification: simpleClassification(),
        plan: [
          {
            claim: 'server IP',
            candidateTools: ['knowledge.search'],
            verificationTier: 'B',
            privacySensitive: false,
          },
        ],
      },
      { reasoner, registry, policy, budget },
    );

    expect(outcome.termination).toBe('budget_exhausted');
    expect(budget.getToolCallsUsed()).toBe(3);
    expect(budget.getIterationsUsed()).toBeLessThanOrEqual(3);
    expect(knowledge.callCount).toBe(3);
  });

  it('investigative budget allows up to 10 tool calls', () => {
    const policy = policyForRequestClass('investigative');
    expect(policy.maxToolCalls).toBe(10);
    const tracker = new BudgetTracker(policy);
    for (let i = 0; i < 10; i++) {
      expect(tracker.canCallTools()).toBe(true);
      tracker.recordToolCalls(1);
    }
    expect(tracker.canCallTools()).toBe(false);
    expect(tracker.exhausted()).toBe(true);
  });

  it('auto-expansion stays within budget and stops once evidence exists', async () => {
    const knowledge = new MockTool(knowledgeSearchMeta, () =>
      okResult('knowledge.search', 'knowledge-indexer', { note: 'no hits' }),
    );
    const docs = new MockTool(docsSearchMeta, () =>
      okResult('docs.search', 'docs-indexer', { value: 'play.enthusia.gg' }),
    );
    const { registry } = mockRegistry([knowledge, docs]);
    // The reasoner gives up immediately; the orchestrator expands the search.
    const reasoner = new MockReasoner({
      classification: simpleClassification(),
      plan: [
        {
          claim: 'server IP',
          candidateTools: ['knowledge.search', 'docs.search'],
          verificationTier: 'B',
          privacySensitive: false,
          params: { query: 'server IP' },
        },
      ],
      decisions: [FINISH],
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));

    expect(knowledge.callCount).toBe(1);
    expect(docs.callCount).toBe(1);
    expect(response.text).toContain('play.enthusia.gg');
    expect(response.text).not.toContain('could not verify');
  });

  it('unknown tools proposed by the reasoner are refused, never executed', async () => {
    const knowledge = new MockTool(knowledgeSearchMeta, () =>
      okResult('knowledge.search', 'knowledge-indexer', { value: 'play.enthusia.gg' }),
    );
    const { registry } = mockRegistry([knowledge]);
    const reasoner = new MockReasoner({
      classification: simpleClassification(),
      plan: [
        {
          claim: 'server IP',
          candidateTools: ['knowledge.search'],
          verificationTier: 'B',
          privacySensitive: false,
        },
      ],
      decisions: [
        {
          action: 'call_tools',
          calls: [
            { toolName: 'does.not.exist', params: {}, claim: 'server IP' },
            { toolName: 'knowledge.search', params: { query: 'server IP' }, claim: 'server IP' },
          ],
        },
        FINISH,
      ],
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));

    expect(knowledge.callCount).toBe(1);
    expect(response.text).toContain('play.enthusia.gg');
  });
});
