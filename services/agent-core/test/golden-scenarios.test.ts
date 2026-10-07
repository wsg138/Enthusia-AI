/**
 * @enthusia/agent-core — golden scenario tests (W12 acceptance).
 *
 * Spec: WORKER-EXECUTION-PLAN.md §15 acceptance — server IP, permission
 * issue, known bug, missing evidence, conflicting evidence, stale memory,
 * irrelevant private context. All scenarios use the mock reasoner and mock
 * tools: NO real inference calls, NO production data.
 */
import { describe, expect, it } from 'vitest';
import { SourceStatus, Visibility } from '@enthusia/contracts';
import { AgentOrchestrator } from '../src/index.js';
import {
  callTool,
  docsSearchMeta,
  errResult,
  FINISH,
  identityLookupMeta,
  knowledgeSearchMeta,
  makeRequest,
  memoryGetMeta,
  MockReasoner,
  MockTool,
  mockRegistry,
  okResult,
  permissionLookupMeta,
  playerActor,
  serverStatusMeta,
  simpleClassification,
} from './mocks.js';

const IP = 'play.enthusia.gg';

function ipKnowledgeTool(): MockTool {
  return new MockTool(knowledgeSearchMeta, () =>
    okResult('knowledge.search', 'knowledge-indexer', {
      value: IP,
      excerpt: `Connect using ${IP}`,
    }),
  );
}

function silentIdentityTool(): MockTool {
  return new MockTool(identityLookupMeta, () =>
    okResult('identity.lookup', 'identity-service', { value: 'should-not-be-read' }, {
      visibility: Visibility.PLAYER_SELF,
    }),
  );
}

describe('W12 golden scenarios', () => {
  it('server IP: simple question verified from source', async () => {
    const knowledge = ipKnowledgeTool();
    const identity = silentIdentityTool();
    const { registry } = mockRegistry([knowledge, identity]);
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
      decisions: [callTool('knowledge.search', 'server IP', { query: 'server IP' }), FINISH],
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));

    expect(response.text).toContain(IP);
    expect(response.text).not.toContain('could not verify');
    expect(response.sources.length).toBeGreaterThanOrEqual(1);
    expect(response.escalation).toBeNull();
    expect(knowledge.callCount).toBe(1);
    // The privacy-sensitive identity tool must not be touched for a public question.
    expect(identity.callCount).toBe(0);
  });

  it('permission issue: investigative, needs identity + config', async () => {
    const identity = new MockTool(identityLookupMeta, () =>
      okResult('identity.lookup', 'identity-service', {
        value: 'Legend',
        excerpt: 'linked uuid-123, rank Legend',
      }, { visibility: Visibility.PLAYER_SELF }),
    );
    const perms = new MockTool(permissionLookupMeta, () =>
      okResult('db.permission_lookup', 'luckperms-db', {
        value: 'denied: missing essentials.fly',
      }, { visibility: Visibility.PLAYER_SELF }),
    );
    const { registry } = mockRegistry([identity, perms]);
    const reasoner = new MockReasoner({
      classification: simpleClassification({
        requestClass: 'investigative',
        summary: 'player lacks /fly permission they expect',
        claims: ['player rank', 'fly permission state'],
        needsPrivateContext: true,
      }),
      plan: [
        {
          claim: 'player rank',
          candidateTools: ['identity.lookup'],
          verificationTier: 'A',
          privacySensitive: true,
        },
        {
          claim: 'fly permission state',
          candidateTools: ['db.permission_lookup'],
          verificationTier: 'A',
          privacySensitive: true,
        },
      ],
      decisions: [
        callTool('identity.lookup', 'player rank'),
        callTool('db.permission_lookup', 'fly permission state'),
        FINISH,
      ],
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    // Staff actor investigating: PLAYER_SELF evidence is disclosable to staff.
    const response = await orchestrator.handleChat(
      makeRequest('A player says they should have /fly but get "no permission"', {
        actor: playerActor({ id: 'staff-9', type: 'staff', displayName: 'StaffNine' }),
        visibilityCeiling: Visibility.STAFF,
      }),
    );

    expect(response.text).toContain('Legend');
    expect(response.text).toContain('denied: missing essentials.fly');
    expect(identity.callCount).toBe(1);
    expect(perms.callCount).toBe(1);
    expect(response.escalation).toBeNull();
  });

  it('known bug: answered from current memory', async () => {
    const memory = new MockTool(memoryGetMeta, () =>
      okResult('memory.get', 'memory-service', {
        value: 'Fly permission is lost after relog (known bug, fixed in 2.4.1)',
        memory: { keyId: 'bug:fly-relog', status: SourceStatus.CURRENT },
      }),
    );
    const { registry } = mockRegistry([memory]);
    const reasoner = new MockReasoner({
      classification: simpleClassification({
        summary: 'player reports fly lost after relog',
        claims: ['known bug: fly lost after relog'],
      }),
      plan: [
        {
          claim: 'known bug: fly lost after relog',
          candidateTools: ['memory.get'],
          verificationTier: 'C',
          privacySensitive: false,
        },
      ],
      decisions: [callTool('memory.get', 'known bug: fly lost after relog'), FINISH],
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(
      makeRequest('I lose /fly every time I relog, is this known?'),
    );

    expect(response.text).toContain('lost after relog');
    expect(response.text).not.toContain('could not verify');
    expect(memory.callCount).toBe(1);
  });

  it('missing evidence: says "could not verify", does not guess', async () => {
    const knowledge = new MockTool(knowledgeSearchMeta, () =>
      okResult('knowledge.search', 'knowledge-indexer', { note: 'no hits' }),
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
      decisions: [callTool('knowledge.search', 'server IP'), FINISH],
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));

    expect(response.text).toContain('could not verify');
    expect(response.text).not.toContain(IP);
  });

  it('conflicting evidence: surfaces uncertainty and escalates to a human', async () => {
    const knowledge = new MockTool(knowledgeSearchMeta, () =>
      okResult('knowledge.search', 'knowledge-indexer', { value: IP }),
    );
    const docs = new MockTool(docsSearchMeta, () =>
      okResult('docs.search', 'docs-indexer', { value: 'mc.enthusia.gg' }),
    );
    const { registry } = mockRegistry([knowledge, docs]);
    const reasoner = new MockReasoner({
      classification: simpleClassification(),
      plan: [
        {
          claim: 'server IP',
          candidateTools: ['knowledge.search', 'docs.search'],
          verificationTier: 'B',
          privacySensitive: false,
        },
      ],
      decisions: [
        callTool('knowledge.search', 'server IP'),
        callTool('docs.search', 'server IP'),
        FINISH,
      ],
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));

    expect(response.text).toContain('conflicting current information');
    expect(response.text).toContain(IP);
    expect(response.text).toContain('mc.enthusia.gg');
    // Never picks a side randomly: escalated for human review.
    expect(response.escalation).not.toBeNull();
    expect(response.escalation?.target).toBe('human');
  });

  it('stale memory: live source wins, memory update proposed (not written)', async () => {
    const memory = new MockTool(memoryGetMeta, () =>
      okResult('memory.get', 'memory-service', {
        value: 'old.enthusia.gg',
        memory: {
          keyId: 'server-ip',
          namespace: 'network',
          key: 'connection.ip',
          scope: 'global',
          status: SourceStatus.CURRENT,
        },
      }),
    );
    const status = new MockTool(serverStatusMeta, () =>
      okResult('server.status', 'mc-status', { value: IP }),
    );
    const { registry } = mockRegistry([memory, status]);
    const reasoner = new MockReasoner({
      classification: simpleClassification(),
      plan: [
        {
          claim: 'server IP',
          candidateTools: ['memory.get', 'server.status'],
          verificationTier: 'A',
          privacySensitive: false,
        },
      ],
      decisions: [
        callTool('memory.get', 'server IP'),
        callTool('server.status', 'server IP'),
        FINISH,
      ],
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));

    // Live (tier A) beats memory (tier C): answer uses the live value.
    expect(response.text).toContain(IP);
    expect(response.text).not.toContain('old.enthusia.gg');
    expect(response.text).not.toContain('could not verify');
    expect(response.escalation).toBeNull();
    // And a supersession is PROPOSED for W05 — never written directly.
    expect(response.memoryUpdates).toHaveLength(1);
    const proposal = response.memoryUpdates[0]!;
    expect(proposal.key).toBe('connection.ip');
    expect(proposal.namespace).toBe('network');
    expect(proposal.value).toBe(IP);
  });

  it('irrelevant private context: privacy-sensitive tools are refused', async () => {
    const knowledge = ipKnowledgeTool();
    const identity = silentIdentityTool();
    const { registry } = mockRegistry([knowledge, identity]);
    const reasoner = new MockReasoner({
      // Even though the (mock) model asks for identity data...
      classification: simpleClassification({ needsPrivateContext: false }),
      plan: [
        {
          claim: 'server IP',
          candidateTools: ['knowledge.search'],
          verificationTier: 'B',
          privacySensitive: false,
          params: { query: 'server IP' },
        },
      ],
      decisions: [
        {
          action: 'call_tools',
          calls: [{ toolName: 'identity.lookup', params: {}, claim: 'server IP' }],
        },
        FINISH,
      ],
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));

    // ...the orchestrator refuses: the tool is never executed.
    expect(identity.callCount).toBe(0);
    // The public question is still answered from public evidence.
    expect(response.text).toContain(IP);
    expect(knowledge.callCount).toBe(1);
  });

  it('malformed request degrades to a safe staff-escalated response', async () => {
    const { registry } = mockRegistry([]);
    const reasoner = new MockReasoner({
      classification: simpleClassification(),
      plan: [],
      decisions: [],
    });
    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest(''));

    expect(response.text).toContain('Something went wrong');
    expect(response.escalation?.target).toBe('human');
  });

  it('error envelopes do not count as evidence', async () => {
    const knowledge = new MockTool(knowledgeSearchMeta, () =>
      errResult('knowledge.search', 'knowledge-indexer', 'index_down', 'index unavailable'),
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
      decisions: [callTool('knowledge.search', 'server IP'), FINISH],
    });

    const orchestrator = new AgentOrchestrator({ reasoner, registry });
    const response = await orchestrator.handleChat(makeRequest('What is the server IP?'));

    expect(response.text).toContain('could not verify');
  });
});
