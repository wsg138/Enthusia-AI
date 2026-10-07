import { describe, expect, it } from 'vitest';
import { SourceStatus, Visibility } from '@enthusia/contracts';
import {
  AgentOrchestrator,
  ToolRegistry,
  assembleResponse,
  resolveResponseStyle,
  type ClaimAssessment,
  type EvidenceItem,
  type ResponseStyleProfile,
  type Tool,
  type VerifiedTopicHelpEvent,
} from '../src/index.js';
import {
  FINISH,
  MockReasoner,
  MockTool,
  callTool,
  knowledgeSearchMeta,
  makeRequest,
  mockRegistry,
  okResult,
} from './mocks.js';

function evidence(id: string, claim: string, value: string): EvidenceItem {
  return {
    id,
    claim,
    value,
    toolName: 'knowledge.search',
    source: 'knowledge-indexer',
    visibility: Visibility.PUBLIC,
    verificationTier: 'B',
    version: id,
    observedTime: '2026-10-06T05:00:00.000Z',
    sourceStatus: SourceStatus.CURRENT,
    current: true,
  };
}

function assessment(id: string, claim: string, value: string): ClaimAssessment {
  const item = evidence(id, claim, value);
  return {
    claim,
    verdict: 'supported',
    supporting: [item],
    contradicting: [],
    assertedValue: value,
    supersededMemories: [],
  };
}

function style(
  familiarity: ResponseStyleProfile['familiarity'],
): ResponseStyleProfile {
  return {
    topic: 'reputation',
    familiarity,
    confidence: familiarity === 'UNKNOWN' ? 0.2 : 0.9,
    basis: familiarity === 'UNKNOWN' ? [] : ['CURRENT_MEMORY'],
  };
}

describe('resolveResponseStyle', () => {
  it('does not query private familiarity when classification does not request it', async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register({
      meta: {
        name: 'player.topic_familiarity',
        description: 'test',
        parameters: { type: 'object', properties: { topic: { type: 'string' } } },
        privacySensitive: true,
        maxVisibility: Visibility.PLAYER_SELF,
      },
      async execute() {
        calls += 1;
        throw new Error('should not run');
      },
    } satisfies Tool);

    const request = {
      ...makeRequest('How does reputation work?', {
        visibilityCeiling: Visibility.PLAYER_SELF,
      }),
      traceId: 'trace-style-1',
    };
    const result = await resolveResponseStyle(
      request,
      {
        requestClass: 'simple',
        summary: 'reputation help',
        claims: [],
        needsPrivateContext: false,
        securitySensitive: false,
      },
      { registry },
    );

    expect(result).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('returns a high-confidence subject-bound familiarity signal', async () => {
    const registry = new ToolRegistry();
    registry.register({
      meta: {
        name: 'player.topic_familiarity',
        description: 'test',
        parameters: { type: 'object', properties: { topic: { type: 'string' } } },
        privacySensitive: true,
        maxVisibility: Visibility.PLAYER_SELF,
      },
      async execute(params, ctx) {
        expect(ctx.actor.type).toBe('player');
        expect(params['topic']).toBe('reputation');
        return {
          toolName: 'player.topic_familiarity',
          timestamp: '2026-10-06T05:00:00.000Z',
          source: 'player-context',
          visibility: Visibility.PLAYER_SELF,
          correlationId: ctx.traceId,
          result: {
            topic: 'reputation',
            level: 'FAMILIAR',
            confidence: 0.88,
            basis: ['CURRENT_MEMORY'],
            observedAt: '2026-10-06T05:00:00.000Z',
          },
        };
      },
    } satisfies Tool);

    const request = {
      ...makeRequest('What is Good Stall?', {
        visibilityCeiling: Visibility.PLAYER_SELF,
      }),
      traceId: 'trace-style-2',
    };
    const result = await resolveResponseStyle(
      request,
      {
        requestClass: 'simple',
        summary: 'Good Stall question',
        claims: ['reputation is a feedback system', 'Good Stall meaning'],
        backgroundClaims: ['reputation is a feedback system'],
        needsFamiliarityContext: true,
        familiarityTopic: 'reputation',
        needsPrivateContext: false,
        securitySensitive: false,
      },
      { registry },
    );

    expect(result).toEqual({
      topic: 'reputation',
      familiarity: 'FAMILIAR',
      confidence: 0.88,
      basis: ['CURRENT_MEMORY'],
    });
  });

  it('downgrades low-confidence familiarity to UNKNOWN', async () => {
    const registry = new ToolRegistry();
    registry.register({
      meta: {
        name: 'player.topic_familiarity',
        description: 'test',
        parameters: { type: 'object', properties: { topic: { type: 'string' } } },
        privacySensitive: true,
        maxVisibility: Visibility.PLAYER_SELF,
      },
      async execute(_params, ctx) {
        return {
          toolName: 'player.topic_familiarity',
          timestamp: '2026-10-06T05:00:00.000Z',
          source: 'player-context',
          visibility: Visibility.PLAYER_SELF,
          correlationId: ctx.traceId,
          result: {
            topic: 'reputation',
            level: 'EXPERT',
            confidence: 0.4,
            basis: ['CONVERSATION'],
            observedAt: '2026-10-06T05:00:00.000Z',
          },
        };
      },
    } satisfies Tool);

    const request = {
      ...makeRequest('What is Good Stall?', {
        visibilityCeiling: Visibility.PLAYER_SELF,
      }),
      traceId: 'trace-style-3',
    };
    const result = await resolveResponseStyle(
      request,
      {
        requestClass: 'simple',
        summary: 'reputation',
        claims: [],
        needsFamiliarityContext: true,
        familiarityTopic: 'reputation',
        needsPrivateContext: false,
        securitySensitive: false,
      },
      { registry },
    );

    expect(result?.familiarity).toBe('UNKNOWN');
    expect(result?.confidence).toBe(0.4);
  });
});

describe('adaptive verified response depth', () => {
  const backgroundOne = assessment('e1', 'reputation is a feedback system', 'player feedback');
  const backgroundTwo = assessment('e2', 'reputation has named reasons', 'named reasons exist');
  const direct = assessment('e3', 'Good Stall meaning', 'positive stall-related feedback');
  const assessments = [backgroundOne, backgroundTwo, direct];
  const allEvidence = assessments.flatMap((item) => item.supporting);
  const request = {
    ...makeRequest('What is Good Stall?'),
    traceId: 'trace-response-style',
  };

  function render(responseStyle: ResponseStyleProfile) {
    return assembleResponse({
      request,
      assessments,
      evidence: allEvidence,
      escalation: null,
      memoryProposals: [],
      draft: {},
      backgroundClaims: [
        'reputation is a feedback system',
        'reputation has named reasons',
      ],
      responseStyle,
    });
  }

  it('NEW players receive verified background plus the direct answer', () => {
    const response = render(style('NEW'));
    expect(response.text).toContain('reputation is a feedback system');
    expect(response.text).toContain('reputation has named reasons');
    expect(response.text).toContain('Good Stall means positive stall-related feedback.');
    expect(response.sources).toHaveLength(3);
  });

  it('FAMILIAR and EXPERT players skip repetitive background facts', () => {
    for (const level of ['FAMILIAR', 'EXPERT'] as const) {
      const response = render(style(level));
      expect(response.text).not.toContain('reputation is a feedback system');
      expect(response.text).not.toContain('reputation has named reasons');
      expect(response.text).toContain('Good Stall means positive stall-related feedback.');
      expect(response.sources).toHaveLength(1);
      expect(response.sources[0]?.description).toContain('Good Stall meaning');
    }
  });

  it('UNKNOWN familiarity includes at most one short background fact', () => {
    const response = render(style('UNKNOWN'));
    expect(response.text).toContain('reputation is a feedback system');
    expect(response.text).not.toContain('reputation has named reasons');
    expect(response.text).toContain('Good Stall means positive stall-related feedback.');
    expect(response.sources).toHaveLength(2);
  });
});

function familiarityMock(): MockTool {
  return new MockTool(
    {
      name: 'player.topic_familiarity',
      description: 'topic familiarity',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
      },
      privacySensitive: true,
      maxVisibility: Visibility.PLAYER_SELF,
    },
    (_params, ctx) =>
      okResult(
        'player.topic_familiarity',
        'player-context',
        {
          topic: 'reputation',
          level: 'FAMILIAR',
          confidence: 0.9,
          basis: ['CURRENT_MEMORY'],
          observedAt: '2026-10-06T05:00:00.000Z',
        },
        {
          visibility: Visibility.PLAYER_SELF,
          correlationId: ctx.traceId,
        },
      ),
  );
}

function adaptiveKnowledgeMock(): MockTool {
  return new MockTool(knowledgeSearchMeta, (params) => {
    const query = String(params['query'] ?? '');
    return okResult(
      'knowledge.search',
      'knowledge-indexer',
      {
        value: query.includes('background')
          ? 'player feedback'
          : 'positive stall-related feedback',
      },
    );
  });
}

function adaptiveReasoner(): MockReasoner {
  return new MockReasoner({
    classification: {
      requestClass: 'investigative',
      summary: 'Good Stall question',
      claims: ['reputation is a feedback system', 'Good Stall meaning'],
      backgroundClaims: ['reputation is a feedback system'],
      needsFamiliarityContext: true,
      familiarityTopic: 'reputation',
      needsPrivateContext: false,
      securitySensitive: false,
    },
    plan: [
      {
        claim: 'reputation is a feedback system',
        candidateTools: ['knowledge.search'],
        verificationTier: 'B',
        privacySensitive: false,
      },
      {
        claim: 'Good Stall meaning',
        candidateTools: ['knowledge.search'],
        verificationTier: 'B',
        privacySensitive: false,
      },
    ],
    decisions: [
      callTool(
        'knowledge.search',
        'reputation is a feedback system',
        { query: 'background reputation' },
      ),
      callTool(
        'knowledge.search',
        'Good Stall meaning',
        { query: 'Good Stall direct answer' },
      ),
      FINISH,
    ],
  });
}

describe('AgentOrchestrator adaptive familiarity integration', () => {
  it('uses the subject-bound style preflight without factual private context', async () => {
    const familiarity = familiarityMock();
    const knowledge = adaptiveKnowledgeMock();
    const { registry } = mockRegistry([familiarity, knowledge]);
    const reasoner = adaptiveReasoner();
    const verifiedHelp: VerifiedTopicHelpEvent[] = [];
    const orchestrator = new AgentOrchestrator({
      reasoner,
      registry,
      nowMs: () => Date.parse('2026-10-06T06:00:00.000Z'),
      onVerifiedTopicHelp: (event) => {
        verifiedHelp.push(event);
      },
    });

    const response = await orchestrator.handleChat(
      makeRequest('What is Good Stall?', {
        visibilityCeiling: Visibility.PLAYER_SELF,
      }),
    );

    expect(familiarity.callCount).toBe(1);
    expect(response.text).not.toContain('reputation is a feedback system');
    expect(response.text).toContain('Good Stall means positive stall-related feedback.');
    expect(reasoner.draftArgs[0]?.responseStyle).toMatchObject({
      topic: 'reputation',
      familiarity: 'FAMILIAR',
    });
    expect(verifiedHelp).toEqual([
      {
        actor: expect.objectContaining({ type: 'player' }),
        topic: 'reputation',
        conversationId: 'conv-1',
        traceId: expect.any(String),
        observedAt: '2026-10-06T06:00:00.000Z',
        supportedDirectClaims: 1,
      },
    ]);
  });

  it('does not learn familiarity when the direct answer is unverified', async () => {
    const familiarity = familiarityMock();
    const knowledge = new MockTool(knowledgeSearchMeta, () =>
      okResult('knowledge.search', 'knowledge-indexer', { note: 'no claim evidence' }),
    );
    const { registry } = mockRegistry([familiarity, knowledge]);
    const reasoner = adaptiveReasoner();
    const verifiedHelp: VerifiedTopicHelpEvent[] = [];
    const orchestrator = new AgentOrchestrator({
      reasoner,
      registry,
      onVerifiedTopicHelp: (event) => {
        verifiedHelp.push(event);
      },
    });

    await orchestrator.handleChat(
      makeRequest('What is Good Stall?', {
        visibilityCeiling: Visibility.PLAYER_SELF,
      }),
    );

    expect(verifiedHelp).toEqual([]);
  });
});
