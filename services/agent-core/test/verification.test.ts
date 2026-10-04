/**
 * @enthusia/agent-core — verification unit tests (W12).
 *
 * Spec §11: current-evidence rules, contradiction detection, stale-memory
 * reconciliation, and memory-proposal validation. Mock tools only.
 */
import { describe, expect, it } from 'vitest';
import { SourceStatus, Visibility } from '@enthusia/contracts';
import {
  assessAllClaimsDisclosable,
  assessClaim,
  decodeFreshness,
  detectContradictions,
  encodeFreshness,
  extractClaimEvidence,
  isCurrentEvidence,
  isToolSuccess,
  normalizeMemoryProposals,
  normalizeValue,
  proposalFromSuperseded,
  looksLikeSecret,
  validateToolParams,
  ToolRegistry,
} from '../src/index.js';
import { errResult, knowledgeSearchMeta, okResult } from './mocks.js';
import type { EvidenceItem } from '../src/index.js';

const NOW = Date.now();
const FRESH = { nowMs: NOW };

function item(
  id: string,
  value: string,
  tier: 'A' | 'B' | 'C' = 'B',
  extra: Partial<EvidenceItem> = {},
): EvidenceItem {
  return {
    id,
    claim: 'server IP',
    value,
    toolName: 't',
    source: `src-${id}`,
    visibility: Visibility.PUBLIC,
    verificationTier: tier,
    current: true,
    ...extra,
  };
}

describe('isCurrentEvidence', () => {
  it('accepts fresh tier-A evidence', () => {
    const r = okResult('t', 's', { value: 'x' });
    expect(isCurrentEvidence(r, 'A', FRESH)).toBe(true);
  });

  it('rejects tier-A evidence observed too long ago', () => {
    const r = okResult('t', 's', { value: 'x' }, {
      freshness: {
        version: 'v1',
        observedTime: new Date(NOW - 10 * 60 * 1000).toISOString(),
        sourceStatus: SourceStatus.CURRENT,
      },
    });
    expect(isCurrentEvidence(r, 'A', FRESH)).toBe(false);
  });

  it('rejects SUPERSEDED sources', () => {
    const r = okResult('t', 's', { value: 'x' }, {
      freshness: {
        version: 'v1',
        observedTime: new Date(NOW).toISOString(),
        sourceStatus: SourceStatus.SUPERSEDED,
      },
    });
    expect(isCurrentEvidence(r, 'B', FRESH)).toBe(false);
  });

  it('rejects missing freshness', () => {
    const r = okResult('t', 's', { value: 'x' }, { freshnessRaw: null });
    expect(isCurrentEvidence(r, 'B', FRESH)).toBe(false);
  });

  it('rejects error envelopes', () => {
    const r = errResult('t', 's');
    expect(isCurrentEvidence(r, 'B', FRESH)).toBe(false);
    expect(isToolSuccess(r)).toBe(false);
  });

  it('rejects tier-C evidence from a non-CURRENT memory revision', () => {
    const r = okResult('t', 's', {
      value: 'x',
      memory: { keyId: 'k', status: SourceStatus.SUPERSEDED },
    });
    expect(isCurrentEvidence(r, 'C', FRESH)).toBe(false);
  });

  it('rejects tier-C evidence without a structured CURRENT memory identity', () => {
    const noIdentity = okResult('t', 's', { value: 'x' });
    const noStatus = okResult('t', 's', { value: 'x', memory: { keyId: 'k' } });
    expect(isCurrentEvidence(noIdentity, 'C', FRESH)).toBe(false);
    expect(isCurrentEvidence(noStatus, 'C', FRESH)).toBe(false);
  });

  it('accepts tier-C evidence from a CURRENT memory revision (flat convention)', () => {
    const r = okResult('t', 's', {
      value: 'x',
      memoryKeyId: 'k',
      memoryStatus: SourceStatus.CURRENT,
    });
    expect(isCurrentEvidence(r, 'C', FRESH)).toBe(true);
  });

  it('accepts bare version strings as freshness (tool-asserted current)', () => {
    const r = okResult('t', 's', { value: 'x' }, { freshnessRaw: 'abc123' });
    expect(isCurrentEvidence(r, 'B', FRESH)).toBe(true);
  });
});

describe('freshness codec', () => {
  it('round-trips structured freshness', () => {
    const info = {
      version: 'sha:abc',
      observedTime: new Date(NOW).toISOString(),
      sourceStatus: SourceStatus.CURRENT,
    };
    expect(decodeFreshness(encodeFreshness(info))).toEqual(info);
  });

  it('returns null for empty or garbage freshness', () => {
    expect(decodeFreshness(undefined)).toBeNull();
    expect(decodeFreshness('')).toBeNull();
    expect(decodeFreshness('{"version":123}')).toBeNull();
  });
});

describe('extractClaimEvidence', () => {
  it('extracts bare-string payloads', () => {
    const r = okResult('t', 's', '  play.enthusia.gg  ');
    const e = extractClaimEvidence('e1', 'server IP', 't', r, 'B', FRESH);
    expect(e?.value).toBe('play.enthusia.gg');
    expect(e?.current).toBe(true);
  });

  it('returns null for payloads without a value', () => {
    const r = okResult('t', 's', { note: 'no hits' });
    expect(extractClaimEvidence('e1', 'server IP', 't', r, 'B', FRESH)).toBeNull();
  });

  it('returns null for error envelopes', () => {
    const r = errResult('t', 's');
    expect(extractClaimEvidence('e1', 'server IP', 't', r, 'B', FRESH)).toBeNull();
  });

  it('carries the memory identity through', () => {
    const r = okResult('t', 's', {
      value: 'x',
      memory: { keyId: 'k1', namespace: 'n', key: 'k', scope: 's' },
    });
    const e = extractClaimEvidence('e1', 'c', 't', r, 'C', FRESH);
    expect(e?.memory?.keyId).toBe('k1');
    expect(e?.memory?.namespace).toBe('n');
  });
});

describe('contradictions and assessment', () => {
  it('detects same-tier contradictions', () => {
    const c = detectContradictions([item('e1', 'a'), item('e2', 'b')]);
    expect(c).toHaveLength(1);
    expect(c[0]!.claim).toBe('server IP');
  });

  it('does not flag tier-A-over-tier-C as a contradiction', () => {
    const c = detectContradictions([
      item('e1', 'old', 'C', { memory: { keyId: 'k' } }),
      item('e2', 'new', 'A'),
    ]);
    expect(c).toHaveLength(0);
  });

  it('ignores non-current evidence', () => {
    const c = detectContradictions([
      item('e1', 'a'),
      item('e2', 'b', 'B', { current: false }),
    ]);
    expect(c).toHaveLength(0);
  });

  it('supports agreement', () => {
    const a = assessClaim('server IP', [item('e1', 'x'), item('e2', 'X ')]);
    expect(a.verdict).toBe('supported');
    expect(a.assertedValue).toBe('x');
  });

  it('marks no-evidence as unsupported', () => {
    const a = assessClaim('server IP', []);
    expect(a.verdict).toBe('unsupported');
    expect(a.assertedValue).toBeUndefined();
  });

  it('marks same-tier disagreement as contradicted', () => {
    const a = assessClaim('server IP', [item('e1', 'a'), item('e2', 'b')]);
    expect(a.verdict).toBe('contradicted');
    expect(a.assertedValue).toBeUndefined();
    expect(a.contradicting).toHaveLength(2);
  });

  it('lets a stronger tier win and reports the stale memory', () => {
    const a = assessClaim('server IP', [
      item('e1', 'old', 'C', { memory: { keyId: 'server-ip' } }),
      item('e2', 'new', 'A'),
    ]);
    expect(a.verdict).toBe('supported');
    expect(a.assertedValue).toBe('new');
    expect(a.supersededMemories).toHaveLength(1);
    expect(a.supersededMemories[0]!.memoryKeyId).toBe('server-ip');
    expect(a.supersededMemories[0]!.evidenceIds).toEqual(['e2']);
  });

  it('disclosable assessment hides above-ceiling evidence', () => {
    const evidence = [
      item('e1', 'secret-value', 'B', { visibility: Visibility.STAFF }),
    ];
    const a = assessAllClaimsDisclosable(['server IP'], evidence, {
      ceiling: Visibility.PUBLIC,
    });
    expect(a[0]!.verdict).toBe('unsupported');
  });

  it('normalizeValue folds case and whitespace', () => {
    expect(normalizeValue('  Play.Enthusia.GG ')).toBe('play.enthusia.gg');
  });
});

describe('memory proposals', () => {
  const evidence = [item('e1', 'v'), item('e2', 'v2')];

  it('builds a proposal from a superseded memory', () => {
    const p = proposalFromSuperseded({
      memoryKeyId: 'server-ip',
      memoryNamespace: 'network',
      memoryKey: 'connection.ip',
      memoryScope: 'global',
      oldValue: 'old',
      newValue: 'new',
      evidenceIds: ['e2'],
    });
    expect(p.namespace).toBe('network');
    expect(p.key).toBe('connection.ip');
    expect(p.value).toBe('new');
    expect(p.summary).toContain('e2');
  });

  it('drops proposals with no evidence reference', () => {
    const out = normalizeMemoryProposals(
      [
        {
          namespace: 'n',
          key: 'k',
          scope: 's',
          summary: 'no evidence mentioned',
          value: 'v',
        },
      ],
      evidence,
    );
    expect(out).toHaveLength(0);
  });

  it('keeps proposals that name known evidence', () => {
    const out = normalizeMemoryProposals(
      [
        {
          namespace: 'n',
          key: 'k',
          scope: 's',
          summary: 'verified. Evidence: e1.',
          value: 'v',
        },
      ],
      evidence,
    );
    expect(out).toHaveLength(1);
  });

  it('drops secret-looking values', () => {
    const out = normalizeMemoryProposals(
      [
        {
          namespace: 'n',
          key: 'k',
          scope: 's',
          summary: 'Evidence: e1',
          value: 'api_key=supersecret123',
        },
      ],
      evidence,
    );
    expect(out).toHaveLength(0);
    expect(looksLikeSecret('api_key=supersecret123')).toBe(true);
    expect(looksLikeSecret('play.enthusia.gg')).toBe(false);
  });

  it('dedupes by identity, last wins', () => {
    const out = normalizeMemoryProposals(
      [
        { namespace: 'n', key: 'k', scope: 's', summary: 'Evidence: e1', value: 'v1' },
        { namespace: 'n', key: 'k', scope: 's', summary: 'Evidence: e2', value: 'v2' },
      ],
      evidence,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe('v2');
  });
});

describe('tool registry', () => {
  it('rejects duplicate registration', () => {
    const registry = new ToolRegistry();
    const tool = {
      meta: knowledgeSearchMeta,
      execute: async () => okResult('knowledge.search', 's', { value: 'x' }),
    };
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/already registered/);
  });

  it('validates params structurally', () => {
    const problems = validateToolParams(knowledgeSearchMeta, {});
    expect(problems).toContain('missing required param: query');
    expect(validateToolParams(knowledgeSearchMeta, { query: 'x' })).toHaveLength(0);
    expect(
      validateToolParams(knowledgeSearchMeta, { query: 'x', bogus: 1 }),
    ).toContain('unknown param: bogus');
    expect(
      validateToolParams(knowledgeSearchMeta, { query: 42 as unknown as string }),
    ).toContain('param query should be string');
  });
});
