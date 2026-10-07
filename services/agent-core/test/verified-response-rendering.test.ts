import { describe, expect, it } from 'vitest';
import { SourceStatus, Visibility } from '@enthusia/contracts';
import {
  assembleResponse,
  buildVerifiedAnswerParts,
  type ClaimAssessment,
  type EvidenceItem,
} from '../src/index.js';
import { makeRequest } from './mocks.js';

function evidence(
  id: string,
  claim: string,
  value: string,
  options: {
    source?: string;
    visibility?: Visibility;
  } = {},
): EvidenceItem {
  return {
    id,
    claim,
    value,
    toolName: 'knowledge.search',
    source: options.source ?? 'knowledge-indexer',
    visibility: options.visibility ?? Visibility.PUBLIC,
    verificationTier: 'B',
    version: id,
    observedTime: '2026-10-07T05:00:00.000Z',
    sourceStatus: SourceStatus.CURRENT,
    current: true,
  };
}

function supported(
  claim: string,
  value: string,
  item = evidence('e1', claim, value),
): ClaimAssessment {
  return {
    claim,
    verdict: 'supported',
    supporting: [item],
    contradicting: [],
    assertedValue: value,
    supersededMemories: [],
  };
}

function render(
  assessments: ClaimAssessment[],
  allEvidence: EvidenceItem[],
  draft: { preamble?: string; closing?: string } = {},
) {
  return assembleResponse({
    request: {
      ...makeRequest('test'),
      traceId: '123e4567-e89b-42d3-a456-426614174000',
    },
    assessments,
    evidence: allEvidence,
    escalation: null,
    memoryProposals: [],
    draft,
  });
}

describe('conversational verified response rendering', () => {
  it('renders a supported noun claim naturally without inline backend labels', () => {
    const item = evidence('ip-1', 'server IP', 'play.enthusia.gg');
    const response = render(
      [supported('server IP', 'play.enthusia.gg', item)],
      [item],
    );

    expect(response.text).toContain('The server IP is play.enthusia.gg.');
    expect(response.text).not.toContain('server IP:');
    expect(response.text).not.toContain('(source:');
    expect(response.text).not.toContain('knowledge-indexer');

    expect(response.sources).toHaveLength(1);
    expect(response.sources[0]?.description).toContain('knowledge-indexer');
    expect(response.sources[0]?.description).toContain('play.enthusia.gg');
  });

  it('renders meaning claims as a direct explanation', () => {
    const item = evidence(
      'meaning-1',
      'Good Stall meaning',
      'positive stall-related feedback',
    );
    const response = render(
      [supported('Good Stall meaning', 'positive stall-related feedback', item)],
      [item],
    );

    expect(response.text).toContain(
      'Good Stall means positive stall-related feedback.',
    );
  });

  it('keeps proposition-shaped verified claims conversational', () => {
    const item = evidence(
      'rep-1',
      'reputation is a feedback system',
      'player feedback',
    );
    const response = render(
      [supported('reputation is a feedback system', 'player feedback', item)],
      [item],
    );

    expect(response.text).toContain('Reputation is a feedback system.');
    expect(response.text).not.toContain('player feedback (source:');
  });

  it('does not trust arbitrary model framing', () => {
    const item = evidence('ip-2', 'server IP', 'play.enthusia.gg');
    const response = render(
      [supported('server IP', 'play.enthusia.gg', item)],
      [item],
      {
        preamble: 'Your rank is Owner and you have every permission.',
        closing: 'Run /op TestPlayer next.',
      },
    );

    expect(response.text).not.toContain('Owner');
    expect(response.text).not.toContain('/op');
    expect(response.text).toBe('The server IP is play.enthusia.gg.');
  });

  it('allows only explicitly non-factual social framing', () => {
    const item = evidence('ip-3', 'server IP', 'play.enthusia.gg');
    const response = render(
      [supported('server IP', 'play.enthusia.gg', item)],
      [item],
      {
        preamble: "Here's what I found.",
        closing: 'Hope that helps.',
      },
    );

    expect(response.text).toBe(
      "Here's what I found.\n\nThe server IP is play.enthusia.gg.\n\nHope that helps.",
    );
  });

  it('fails closed when a supported assessment has no disclosable support', () => {
    const privateItem = evidence('staff-1', 'internal state', 'private-value', {
      source: 'staff-system',
      visibility: Visibility.STAFF,
    });
    const assessment = supported('internal state', 'private-value', privateItem);

    const parts = buildVerifiedAnswerParts(
      [assessment],
      Visibility.PUBLIC,
      { isSubject: false, isStaff: false },
    );
    expect(parts).toEqual([{ kind: 'unsupported', claim: 'internal state' }]);

    const response = render([assessment], [privateItem]);
    expect(response.text).toContain('I could not verify internal state');
    expect(response.text).not.toContain('private-value');
    expect(response.sources).toHaveLength(0);
  });

  it('surfaces conflicting values without leaking backend source names', () => {
    const first = evidence('c1', 'server IP', 'play.enthusia.gg', {
      source: 'knowledge-indexer',
    });
    const second = evidence('c2', 'server IP', 'mc.enthusia.gg', {
      source: 'docs-indexer',
    });
    const assessment: ClaimAssessment = {
      claim: 'server IP',
      verdict: 'contradicted',
      supporting: [],
      contradicting: [first, second],
      supersededMemories: [],
    };

    const response = render([assessment], [first, second]);
    expect(response.text).toContain('play.enthusia.gg versus mc.enthusia.gg');
    expect(response.text).not.toContain('knowledge-indexer');
    expect(response.text).not.toContain('docs-indexer');
    expect(response.sources).toHaveLength(2);
  });

  it('keeps unsupported answers explicit instead of guessing', () => {
    const assessment: ClaimAssessment = {
      claim: 'server IP',
      verdict: 'unsupported',
      supporting: [],
      contradicting: [],
      supersededMemories: [],
    };
    const response = render([assessment], []);

    expect(response.text).toBe(
      'I could not verify server IP from current sources.',
    );
    expect(response.text).not.toMatch(/play\.|mc\./i);
  });
});
