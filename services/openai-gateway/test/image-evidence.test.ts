import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  ConfigError,
  CostTracker,
  DEFAULT_MODEL_PRICES,
  DEFAULT_MODEL_SELECTION,
  ImageEvidenceDeniedError,
  OpenAIParseError,
  parseImageEvidenceAssessment,
  runImageEvidenceAssessment,
  type GatewayConfig,
} from '../src/index.js';
import {
  chatCompletionsOk,
  FAKE_API_KEY,
  startMockOpenAIServer,
} from './helpers.js';

const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);
const IMAGE_SHA =
  '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';

function config(baseUrl: string, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    apiKey: FAKE_API_KEY,
    baseUrl,
    timeoutMs: 5_000,
    maxOutputTokens: 4_096,
    visionModel: 'vision-test-model',
    modelSelection: DEFAULT_MODEL_SELECTION,
    modelPrices: DEFAULT_MODEL_PRICES,
    budget: {
      maxUsdPerRequest: 2,
      maxUsdPerDay: 10,
      maxEscalationsPerRequest: 3,
    },
    ...overrides,
  };
}

function validAssessment(): string {
  return JSON.stringify({
    summary: 'Minecraft chat evidence screenshot.',
    observations: [
      {
        category: 'visible_text',
        text: 'Visible chat line reads: example text',
        confidence: 0.96,
      },
      {
        category: 'game_ui',
        text: 'Minecraft chat interface is visible.',
        confidence: 0.99,
      },
    ],
    inferences: [
      {
        text: 'The visible text appears to be part of an in-game chat conversation.',
        confidence: 0.8,
        observationIndexes: [0, 1],
      },
    ],
    limitations: ['The screenshot does not show messages before this excerpt.'],
    needsMoreContext: true,
  });
}

describe('runImageEvidenceAssessment', () => {
  it('returns a structured observation-only assessment and records usage', async () => {
    const server = await startMockOpenAIServer(
      chatCompletionsOk(validAssessment(), {
        prompt_tokens: 900,
        completion_tokens: 250,
        total_tokens: 1150,
      }),
    );
    try {
      const tracker = new CostTracker(
        config(server.url).budget,
        DEFAULT_MODEL_PRICES,
      );
      const result = await runImageEvidenceAssessment(
        {
          traceId: 'trace-image-1',
          evidenceRef: 'ticket:12:message:34:attachment:56',
          image: {
            bytes: IMAGE_BYTES,
            contentType: 'image/png',
            sha256: IMAGE_SHA,
          },
          context: {
            ticketCategory: 'report',
            userQuestion: 'Does this screenshot show useful evidence?',
          },
        },
        { config: config(server.url), tracker },
      );

      expect(result.evidenceSha256).toBe(IMAGE_SHA);
      expect(result.model).toBe('mock-model');
      expect(result.assessment.observations).toHaveLength(2);
      expect(result.assessment.inferences[0]?.observationIndexes).toEqual([0, 1]);
      expect(result.assessment.needsMoreContext).toBe(true);
      expect(result.usage.totalTokens).toBe(1150);
      expect(result.estimatedCostUsd).toBeGreaterThan(0);
      expect(tracker.callsForRequest('trace-image-1')).toBe(1);

      const body = server.requests[0] as Record<string, unknown>;
      expect(JSON.stringify(body)).toContain('data:image/png;base64,AQIDBA==');
      expect(JSON.stringify(body)).not.toContain('discordapp');
      expect(JSON.stringify(body)).not.toContain('"punishment"');
    } finally {
      await server.close();
    }
  });

  it('fails before network access when the provenance hash does not match', async () => {
    await expect(
      runImageEvidenceAssessment(
        {
          traceId: 'trace-image-hash',
          evidenceRef: 'ticket:test',
          image: {
            bytes: IMAGE_BYTES,
            contentType: 'image/png',
            sha256:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        },
        { config: config('http://127.0.0.1:1') },
      ),
    ).rejects.toBeInstanceOf(ImageEvidenceDeniedError);
  });

  it('requires an explicitly configured vision model', async () => {
    const withoutVision = config('http://127.0.0.1:1');
    delete withoutVision.visionModel;
    await expect(
      runImageEvidenceAssessment(
        {
          traceId: 'trace-image-model',
          evidenceRef: 'ticket:test',
          image: {
            bytes: IMAGE_BYTES,
            contentType: 'image/png',
            sha256: IMAGE_SHA,
          },
        },
        { config: withoutVision },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('uses the existing OpenAI budget before making a vision call', async () => {
    const limited = config('http://127.0.0.1:1', {
      budget: {
        maxUsdPerRequest: 0.000001,
        maxUsdPerDay: 10,
        maxEscalationsPerRequest: 3,
      },
    });
    await expect(
      runImageEvidenceAssessment(
        {
          traceId: 'trace-image-budget',
          evidenceRef: 'ticket:test',
          image: {
            bytes: IMAGE_BYTES,
            contentType: 'image/png',
            sha256: IMAGE_SHA,
          },
        },
        { config: limited },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('honors the per-trace external-call cap', async () => {
    const cfg = config('http://127.0.0.1:1', {
      budget: {
        maxUsdPerRequest: 2,
        maxUsdPerDay: 10,
        maxEscalationsPerRequest: 1,
      },
    });
    const tracker = new CostTracker(cfg.budget, DEFAULT_MODEL_PRICES);
    tracker.recordUsage({
      traceId: 'trace-image-cap',
      packetRef: 'previous',
      model: 'vision-test-model',
      promptTokens: 10,
      completionTokens: 10,
    });

    await expect(
      runImageEvidenceAssessment(
        {
          traceId: 'trace-image-cap',
          evidenceRef: 'ticket:test',
          image: {
            bytes: IMAGE_BYTES,
            contentType: 'image/png',
            sha256: IMAGE_SHA,
          },
        },
        { config: cfg, tracker },
      ),
    ).rejects.toBeInstanceOf(ImageEvidenceDeniedError);
  });
});

describe('parseImageEvidenceAssessment', () => {
  it('rejects unexpected authority-shaped fields', () => {
    const parsed = JSON.parse(validAssessment()) as Record<string, unknown>;
    parsed['punishment'] = 'ban';
    expect(() =>
      parseImageEvidenceAssessment(JSON.stringify(parsed)),
    ).toThrowError(OpenAIParseError);
  });

  it('rejects free-floating inferences with no observation basis', () => {
    const parsed = JSON.parse(validAssessment()) as {
      inferences: Array<Record<string, unknown>>;
    };
    parsed.inferences[0]!['observationIndexes'] = [];
    expect(() =>
      parseImageEvidenceAssessment(JSON.stringify(parsed)),
    ).toThrow(/observation indexes/);
  });

  it('rejects inference references outside the observation list', () => {
    const parsed = JSON.parse(validAssessment()) as {
      inferences: Array<Record<string, unknown>>;
    };
    parsed.inferences[0]!['observationIndexes'] = [99];
    expect(() =>
      parseImageEvidenceAssessment(JSON.stringify(parsed)),
    ).toThrow(/invalid observation/);
  });

  it('accepts a single JSON code fence but not extra schema fields', () => {
    const fenced = '```json\n' + validAssessment() + '\n```';
    expect(parseImageEvidenceAssessment(fenced).summary).toContain('Minecraft');
  });
});
