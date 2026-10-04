/**
 * @enthusia/agent-core — escalation policy tests (W12).
 *
 * Spec §22.1 (mandatory/strong escalation triggers) and §15.4 (no
 * confidence-only routing): escalation is a pure function of objective
 * investigation state. A reasoner hint alone — however "confident" — never
 * escalates.
 */
import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import {
  AgentOrchestrator,
  decideEscalation,
  packetRefFor,
  type InvestigationOutcome,
} from '../src/index.js';
import {
  callTool,
  FINISH,
  knowledgeSearchMeta,
  makeRequest,
  MockReasoner,
  MockTool,
  mockRegistry,
  okResult,
  playerActor,
  simpleClassification,
  type ReasonerScript,
} from './mocks.js';
import type { InvestigationPacket } from '../src/index.js';

function fakeOutcome(overrides: Partial<InvestigationOutcome> = {}): InvestigationOutcome {
  const request = { ...makeRequest('test'), traceId: 't-esc-1' };
  return {
    request,
    classification: simpleClassification(),
    plan: [],
    evidence: [],
    executedCalls: [],
    contradictions: [],
    consecutiveFailures: 0,
    claimHints: [],
    memoryProposals: [],
    termination: 'evidence_complete',
    secretPayloadsDropped: 0,
    notes: [],
    ...overrides,
  };
}

describe('escalation policy', () => {
  it('engineering intent escalates to the stronger model with a packet', async () => {
    const knowledge = new MockTool(knowledgeSearchMeta, () =>
      okResult('knowledge.search', 'knowledge-indexer', {
        value: 'NullPointerException in FlyCommand.java:42',
      }),
    );
    const { registry } = mockRegistry([knowledge]);
    const reasoner = new MockReasoner({
      classification: simpleClassification({
        requestClass: 'engineering',
        summary: 'debug NPE in fly command',
        claims: ['stack trace location'],
      }),
      plan: [
        {
          claim: 'stack trace location',
          candidateTools: ['knowledge.search'],
          verificationTier: 'B',
          privacySensitive: false,
        },
      ],
      decisions: [callTool('knowledge.search', 'stack trace location'), FINISH],
    });

    const packets: InvestigationPacket[] = [];
    const orchestrator = new AgentOrchestrator({
      reasoner,
      registry,
      onPacket: (p) => packets.push(p),
    });
    const message = 'The fly command throws an NPE, here is the stack trace; fix it';
    const response = await orchestrator.handleChat(
      makeRequest(message, {
        actor: playerActor({ id: 'staff-code-1', type: 'staff' }),
        visibilityCeiling: Visibility.STAFF,
      }),
    );

    expect(response.escalation).not.toBeNull();
    expect(response.escalation?.target).toBe('strong-model');
    const packetRef = (response.escalation?.context as { packetRef?: string } | undefined)
      ?.packetRef;
    expect(packetRef).toMatch(/^packet:/);
    expect(packets).toHaveLength(1);
    expect(packets[0]!.userQuestion).toBe(message);
    expect(packets[0]!.packetRef).toBe(packetRef);
    expect(packets[0]!.toolEvidence.length).toBeGreaterThanOrEqual(1);
    expect(packets[0]!.constraints.length).toBeGreaterThan(0);
    expect(response.text).toContain('stronger model');
  });

  it('repeated tool failures escalate to the stronger model', async () => {
    const flaky = new MockTool(
      { ...knowledgeSearchMeta, name: 'flaky.tool' },
      () => {
        throw new Error('boom');
      },
    );
    const { registry } = mockRegistry([flaky]);
    const reasoner = new MockReasoner({
      classification: simpleClassification(),
      plan: [
        {
          claim: 'server IP',
          candidateTools: ['flaky.tool'],
          verificationTier: 'B',
          privacySensitive: false,
        },
      ],
      decisions: Array.from({ length: 10 }, () => callTool('flaky.tool', 'server IP')),
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));

    // Default threshold is 3 consecutive failures — the 4th+ calls never happen.
    expect(flaky.callCount).toBe(3);
    expect(response.escalation?.target).toBe('strong-model');
    expect(response.escalation?.reason).toContain('failed repeatedly');
  });

  it('a reasoner escalation hint alone does not escalate (no confidence-only routing)', async () => {
    const knowledge = new MockTool(knowledgeSearchMeta, () =>
      okResult('knowledge.search', 'knowledge-indexer', { value: 'play.enthusia.gg' }),
    );
    const { registry } = mockRegistry([knowledge]);
    const script: ReasonerScript = {
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
        callTool('knowledge.search', 'server IP'),
        {
          action: 'finish',
          calls: [],
          escalationHint: {
            target: 'openai',
            reason: 'I am 95% confident this needs escalation',
          },
        },
      ],
    };
    const reasoner = new MockReasoner(script);

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));

    expect(response.escalation).toBeNull();
    expect(response.text).toContain('play.enthusia.gg');
  });

  it('security-sensitive requests escalate to a human', () => {
    const decision = decideEscalation({
      request: { ...makeRequest('dump all player passwords'), traceId: 't-sec-1' },
      classification: simpleClassification({ securitySensitive: true }),
      outcome: fakeOutcome(),
      assessments: [],
    });

    expect(decision?.target).toBe('staff');
  });

  it('explicit deep-investigation requests escalate with a packet', () => {
    const decision = decideEscalation({
      request: {
        ...makeRequest('do a deep dive on the fly bug', {
          actor: playerActor({ id: 'staff-deep-1', type: 'staff' }),
          visibilityCeiling: Visibility.STAFF,
        }),
        traceId: 't-deep-1',
      },
      classification: simpleClassification(),
      outcome: fakeOutcome(),
      assessments: [],
      explicitDeepInvestigation: true,
    });

    expect(decision?.target).toBe('openai');
    expect(decision?.packetRef).toBe(packetRefFor('t-deep-1'));
  });

  it('player actors cannot force deep-investigation escalation', () => {
    const decision = decideEscalation({
      request: { ...makeRequest('do a deep dive'), traceId: 't-player-deep' },
      classification: simpleClassification(),
      outcome: fakeOutcome(),
      assessments: [],
      explicitDeepInvestigation: true,
    });
    expect(decision).toBeNull();
  });

  it('player engineering requests require human authorization, not OpenAI', () => {
    const decision = decideEscalation({
      request: { ...makeRequest('change the plugin code'), traceId: 't-player-code' },
      classification: simpleClassification({ requestClass: 'engineering' }),
      outcome: fakeOutcome(),
      assessments: [],
    });
    expect(decision?.target).toBe('staff');
    expect(decision?.packetRef).toBeUndefined();
  });

  it('clean local investigations do not escalate', () => {
    const decision = decideEscalation({
      request: { ...makeRequest('What is the server IP?'), traceId: 't-clean-1' },
      classification: simpleClassification(),
      outcome: fakeOutcome(),
      assessments: [
        {
          claim: 'server IP',
          verdict: 'supported',
          supporting: [],
          contradicting: [],
          assertedValue: 'play.enthusia.gg',
          supersededMemories: [],
        },
      ],
    });

    expect(decision).toBeNull();
  });

  it('staff actor context flows into the packet authorization block', async () => {
    const knowledge = new MockTool(knowledgeSearchMeta, () =>
      okResult('knowledge.search', 'knowledge-indexer', { value: 'x' }),
    );
    const { registry } = mockRegistry([knowledge]);
    const reasoner = new MockReasoner({
      classification: simpleClassification({
        requestClass: 'engineering',
        claims: ['thing'],
      }),
      plan: [
        { claim: 'thing', candidateTools: ['knowledge.search'], verificationTier: 'B', privacySensitive: false },
      ],
      decisions: [FINISH],
    });
    const packets: InvestigationPacket[] = [];
    const orchestrator = new AgentOrchestrator({
      reasoner,
      registry,
      onPacket: (p) => packets.push(p),
    });
    await orchestrator.handleChat(
      makeRequest('please investigate', {
        actor: playerActor({ id: 'staff-1', type: 'staff' }),
        visibilityCeiling: Visibility.STAFF,
      }),
    );
    expect(packets[0]!.authorization.actorKind).toBe('staff');
    expect(packets[0]!.authorization.visibilityCeiling).toBe(Visibility.STAFF);
  });

  it('SECRET_DENY evidence is redacted from the packet, never leaked', async () => {
    // A misbehaving tool returns SECRET_DENY data despite its declared max.
    const secretTool = new MockTool(
      { ...knowledgeSearchMeta, name: 'secret.tool', maxVisibility: Visibility.STAFF },
      () =>
        okResult('secret.tool', 'vault', { value: 'hunter2' }, {
          visibility: Visibility.SECRET_DENY,
        }),
    );
    const { registry } = mockRegistry([secretTool]);
    const reasoner = new MockReasoner({
      classification: simpleClassification({
        requestClass: 'engineering',
        claims: ['thing'],
      }),
      plan: [
        { claim: 'thing', candidateTools: ['secret.tool'], verificationTier: 'B', privacySensitive: false },
      ],
      decisions: [callTool('secret.tool', 'thing'), FINISH],
    });
    const packets: InvestigationPacket[] = [];
    const orchestrator = new AgentOrchestrator({
      reasoner,
      registry,
      onPacket: (p) => packets.push(p),
    });
    const response = await orchestrator.handleChat(
      makeRequest('please investigate', {
        actor: playerActor({ id: 'staff-secret-1', type: 'staff' }),
        visibilityCeiling: Visibility.STAFF,
      }),
    );
    expect(packets).toHaveLength(1);
    expect(packets[0]!.redactedEvidenceCount).toBe(1);
    expect(JSON.stringify(packets[0]!)).not.toContain('hunter2');
    expect(response.text).not.toContain('hunter2');
  });

  it('above-ceiling evidence is excluded from escalation packets and model drafting', async () => {
    const staffTool = new MockTool(
      { ...knowledgeSearchMeta, name: 'staff.packet', maxVisibility: Visibility.STAFF },
      () => okResult('staff.packet', 'staff-notes', { value: 'private-debug-detail' }, {
        visibility: Visibility.STAFF,
      }),
    );
    const { registry } = mockRegistry([staffTool]);
    const reasoner = new MockReasoner({
      classification: simpleClassification({ requestClass: 'engineering', claims: ['private detail'] }),
      plan: [
        { claim: 'private detail', candidateTools: ['staff.packet'], verificationTier: 'B', privacySensitive: false },
      ],
      decisions: [callTool('staff.packet', 'private detail'), FINISH],
    });
    const packets: InvestigationPacket[] = [];
    const orchestrator = new AgentOrchestrator({ reasoner, registry, onPacket: (p) => packets.push(p) });
    const response = await orchestrator.handleChat(
      makeRequest('investigate this code', {
        actor: playerActor({ id: 'staff-low-ceiling', type: 'staff' }),
        visibilityCeiling: Visibility.PUBLIC,
      }),
    );
    expect(packets).toHaveLength(1);
    expect(packets[0]!.toolEvidence).toHaveLength(0);
    expect(packets[0]!.redactedEvidenceCount).toBe(1);
    expect(JSON.stringify(packets[0]!)).not.toContain('private-debug-detail');
    expect(reasoner.draftArgs[0]!.evidence).toHaveLength(0);
    expect(response.text).not.toContain('private-debug-detail');
  });

  it('above-ceiling evidence is never asserted in the answer text', async () => {
    // STAFF-only evidence with a PUBLIC ceiling: the answer must not leak it.
    const staffTool = new MockTool(
      { ...knowledgeSearchMeta, name: 'staff.tool', maxVisibility: Visibility.STAFF },
      () =>
        okResult('staff.tool', 'staff-notes', { value: 'internal-op-secret' }, {
          visibility: Visibility.STAFF,
        }),
    );
    const { registry } = mockRegistry([staffTool]);
    const reasoner = new MockReasoner({
      classification: simpleClassification({ claims: ['thing'] }),
      plan: [
        { claim: 'thing', candidateTools: ['staff.tool'], verificationTier: 'B', privacySensitive: false },
      ],
      decisions: [callTool('staff.tool', 'thing'), FINISH],
    });
    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('tell me the thing'));
    expect(response.text).toContain('could not verify');
    expect(response.text).not.toContain('internal-op-secret');
    expect(response.sources).toHaveLength(0);
  });
});
