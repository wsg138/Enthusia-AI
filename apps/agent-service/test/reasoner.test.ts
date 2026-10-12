import { describe, expect, it } from 'vitest';
import { Visibility, type ChatRequest } from '@enthusia/contracts';
import type {
  GenerationRequest,
  GenerationResult,
} from '@enthusia/inference-adapter';
import { InferenceReasoner } from '../src/reasoner.js';

class FakeCompletionClient {
  readonly calls: GenerationRequest[] = [];

  constructor(private readonly outputs: string[]) {}

  async complete(
    request: GenerationRequest,
  ): Promise<GenerationResult> {
    this.calls.push(request);
    const content = this.outputs.shift();
    if (content === undefined) throw new Error('no fake completion queued');
    return {
      content,
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: 'fake-local-model',
      latencyMs: 1,
      attempts: 1,
    };
  }
}

function request(): ChatRequest {
  return {
    surface: 'discord',
    actor: { id: 'user-1', type: 'player' },
    conversationId: 'conv-1',
    message: 'What is the current server IP?',
    visibilityCeiling: Visibility.PUBLIC,
    traceId: '123e4567-e89b-12d3-a456-426614174000',
  };
}

describe('InferenceReasoner', () => {
  it('accepts validated JSON intent output', async () => {
    const client = new FakeCompletionClient([
      JSON.stringify({
        requestClass: 'simple',
        summary: 'Find the current server IP',
        claims: ['current server IP'],
        needsPrivateContext: false,
        securitySensitive: false,
      }),
    ]);
    const reasoner = new InferenceReasoner(client);
    await expect(reasoner.classifyIntent(request())).resolves.toEqual({
      requestClass: 'simple',
      summary: 'Find the current server IP',
      claims: ['current server IP'],
      needsPrivateContext: false,
      securitySensitive: false,
    });
  });

  it('accepts bounded adaptive-explanation classification fields', async () => {
    const client = new FakeCompletionClient([
      JSON.stringify({
        requestClass: 'simple',
        summary: 'Explain Good Stall',
        claims: ['reputation is a feedback system', 'Good Stall meaning'],
        backgroundClaims: ['reputation is a feedback system'],
        needsFamiliarityContext: true,
        familiarityTopic: 'reputation',
        needsPrivateContext: false,
        securitySensitive: false,
      }),
    ]);
    const reasoner = new InferenceReasoner(client);
    await expect(reasoner.classifyIntent(request())).resolves.toMatchObject({
      backgroundClaims: ['reputation is a feedback system'],
      needsFamiliarityContext: true,
      familiarityTopic: 'reputation',
    });
  });

  it('rejects malformed or extra-control output instead of guessing', async () => {
    const malformed = new InferenceReasoner(
      new FakeCompletionClient(['not json']),
    );
    await expect(malformed.classifyIntent(request())).rejects.toThrow(
      'non-JSON',
    );

    const extraField = new InferenceReasoner(
      new FakeCompletionClient([
        JSON.stringify({
          requestClass: 'simple',
          summary: 'x',
          claims: ['x'],
          needsPrivateContext: false,
          securitySensitive: false,
          inventedControl: true,
        }),
      ]),
    );
    await expect(extraField.classifyIntent(request())).rejects.toThrow(
      'invalid JSON shape',
    );
  });

  it('accepts a single output wrapper and ignores only a blank optional topic', async () => {
    const client = new FakeCompletionClient([
      JSON.stringify({ output: {
        requestClass: 'simple',
        summary: 'User asked what AI can do',
        claims: [],
        backgroundClaims: [],
        needsFamiliarityContext: false,
        familiarityTopic: '',
        needsPrivateContext: false,
        securitySensitive: false,
      } }),
    ]);
    const classified = await new InferenceReasoner(client).classifyIntent(request());
    expect(classified.requestClass).toBe('simple');
    expect(classified.claims).toEqual([]);
    expect('familiarityTopic' in classified).toBe(false);
  });

  it('still rejects extra controls inside and outside the output wrapper', async () => {
    for (const bad of [
      { output: { requestClass: 'simple', summary: 'x', claims: [], needsPrivateContext: false, securitySensitive: false, permitSecretAccess: true } },
      { output: { requestClass: 'simple', summary: 'x', claims: [], needsPrivateContext: false, securitySensitive: false }, permitSecretAccess: true },
    ]) {
      const reasoner = new InferenceReasoner(new FakeCompletionClient([JSON.stringify(bad)]));
      await expect(reasoner.classifyIntent(request())).rejects.toThrow('invalid JSON shape');
    }
  });

  it('validates one output wrapper containing an evidence-plan array', async () => {
    const reasoner = new InferenceReasoner(new FakeCompletionClient([
      JSON.stringify({ output: [{ claim: 'current server IP', candidateTools: [], verificationTier: 'B', privacySensitive: false }] }),
    ]));
    const result = await reasoner.planEvidence(request(),
      {
        requestClass: 'simple',
        summary: 'server IP',
        claims: ['current server IP'],
        needsPrivateContext: false,
        securitySensitive: false,
      }, [{
        name: 'knowledge.search',
        description: 'search current evidence',
        parameters: { type: 'object', properties: {} },
        privacySensitive: false,
        maxVisibility: Visibility.PUBLIC,
      }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.candidateTools).toEqual([]);
  });

  it('does not ask the model to invent an evidence plan with zero available tools', async () => {
    const client = new FakeCompletionClient([]);
    const reasoner = new InferenceReasoner(client);
    const plan = await reasoner.planEvidence(
      request(),
      { requestClass: 'simple', summary: 'test', claims: ['current server IP'], needsPrivateContext: false, securitySensitive: false },
      [],
    );
    expect(plan).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it('normalizes optional plan fields without explicit undefined values', async () => {
    const client = new FakeCompletionClient([
      JSON.stringify([
        {
          claim: 'current server IP',
          candidateTools: ['knowledge.search'],
          verificationTier: 'B',
          privacySensitive: false,
        },
      ]),
    ]);
    const reasoner = new InferenceReasoner(client);
    const plan = await reasoner.planEvidence(
      request(),
      {
        requestClass: 'simple',
        summary: 'server ip',
        claims: ['current server IP'],
        needsPrivateContext: false,
        securitySensitive: false,
      },
      [
        {
          name: 'knowledge.search',
          description: 'search current knowledge',
          parameters: { type: 'object', properties: {} },
          verificationTier: 'B',
          privacySensitive: false,
          maxVisibility: Visibility.PUBLIC,
        },
      ],
    );
    expect(plan).toEqual([
      {
        claim: 'current server IP',
        candidateTools: ['knowledge.search'],
        verificationTier: 'B',
        privacySensitive: false,
      },
    ]);
    expect('params' in plan[0]!).toBe(false);
  });

  it('does not let the model draft factual answer prose', async () => {
    const client = new FakeCompletionClient([]);
    const reasoner = new InferenceReasoner(client);
    await expect(reasoner.draftResponse()).resolves.toEqual({});
    expect(client.calls).toHaveLength(0);
  });
});
