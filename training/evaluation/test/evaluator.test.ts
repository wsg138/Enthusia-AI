/**
 * Unit tests: evaluator harness (runner + assertions).
 */
import { describe, expect, it } from 'vitest';
import type { Assertion, EvalCase, EvalResponse, SystemUnderTest } from '../src/index.js';
import {
  evaluateAssertion,
  runCases,
  mergeContext,
  idealSystem,
  SEED_GOLDEN_CASES,
} from '../src/index.js';

function resp(partial: Partial<EvalResponse>): EvalResponse {
  return {
    answer: '',
    sourcesUsed: [],
    toolCalls: [],
    escalated: 'none',
    disclosedVisibility: [],
    ...partial,
  };
}

describe('evaluateAssertion', () => {
  it('contains / notContains', () => {
    const r = resp({ answer: 'The /home cooldown is 5s' });
    expect(evaluateAssertion({ type: 'contains', value: '5s' }, r).passed).toBe(true);
    expect(evaluateAssertion({ type: 'contains', value: '10s' }, r).passed).toBe(false);
    expect(evaluateAssertion({ type: 'notContains', value: '10s' }, r).passed).toBe(true);
    expect(evaluateAssertion({ type: 'notContains', value: '5s' }, r).passed).toBe(false);
  });

  it('matches / notMatches with invalid regex reported as failure', () => {
    const r = resp({ answer: 'Could you clarify which command?' });
    expect(evaluateAssertion({ type: 'matches', pattern: 'clarif' }, r).passed).toBe(true);
    expect(evaluateAssertion({ type: 'matches', pattern: 'zzz' }, r).passed).toBe(false);
    expect(evaluateAssertion({ type: 'matches', pattern: '([' }, r).passed).toBe(false);
    expect(evaluateAssertion({ type: 'notMatches', pattern: 'zzz' }, r).passed).toBe(true);
    expect(evaluateAssertion({ type: 'notMatches', pattern: 'clarif' }, r).passed).toBe(false);
  });

  it('escalatedTo defaults to none', () => {
    expect(
      evaluateAssertion({ type: 'escalatedTo', target: 'none' }, resp({ answer: 'x' })).passed,
    ).toBe(true);
    expect(
      evaluateAssertion({ type: 'escalatedTo', target: 'staff' }, resp({ answer: 'x' })).passed,
    ).toBe(false);
    expect(
      evaluateAssertion(
        { type: 'escalatedTo', target: 'staff' },
        resp({ answer: 'x', escalated: 'staff' }),
      ).passed,
    ).toBe(true);
  });

  it('toolCalled / toolNotCalled with maxCalls', () => {
    const r = resp({
      answer: 'x',
      toolCalls: [{ tool: 'knowledge.search' }, { tool: 'knowledge.search' }],
    });
    expect(evaluateAssertion({ type: 'toolCalled', tool: 'knowledge.search' }, r).passed).toBe(true);
    expect(
      evaluateAssertion({ type: 'toolCalled', tool: 'knowledge.search', maxCalls: 1 }, r).passed,
    ).toBe(false);
    expect(evaluateAssertion({ type: 'toolCalled', tool: 'player.resolve' }, r).passed).toBe(false);
    expect(evaluateAssertion({ type: 'toolNotCalled', tool: 'player.resolve' }, r).passed).toBe(true);
    expect(evaluateAssertion({ type: 'toolNotCalled', tool: 'knowledge.search' }, r).passed).toBe(false);
  });

  it('noDisclosureAbove enforces the ceiling and forbidden strings', () => {
    const a: Assertion = { type: 'noDisclosureAbove', ceiling: 'PUBLIC' };
    expect(evaluateAssertion(a, resp({ answer: 'ok' })).passed).toBe(true);
    expect(
      evaluateAssertion(a, resp({ answer: 'ok', disclosedVisibility: ['STAFF'] })).passed,
    ).toBe(false);
    expect(
      evaluateAssertion(a, resp({ answer: 'ok', disclosedVisibility: ['PUBLIC'] })).passed,
    ).toBe(true);
    // SECRET_DENY is never disclosable, even under a high ceiling.
    const high: Assertion = { type: 'noDisclosureAbove', ceiling: 'MANAGEMENT' };
    expect(
      evaluateAssertion(high, resp({ answer: 'ok', disclosedVisibility: ['SECRET_DENY'] })).passed,
    ).toBe(false);
    // forbidden strings are checked against the answer text.
    const forb: Assertion = { type: 'noDisclosureAbove', ceiling: 'PUBLIC', forbidden: ['xray'] };
    expect(evaluateAssertion(forb, resp({ answer: 'warned for xray' })).passed).toBe(false);
    // PLAYER_SELF requires isSubject or isStaff.
    const self: Assertion = { type: 'noDisclosureAbove', ceiling: 'PLAYER_SELF' };
    expect(
      evaluateAssertion(self, resp({ answer: 'ok', disclosedVisibility: ['PLAYER_SELF'] })).passed,
    ).toBe(false);
    const selfOk: Assertion = {
      type: 'noDisclosureAbove',
      ceiling: 'PLAYER_SELF',
      isSubject: true,
    };
    expect(
      evaluateAssertion(selfOk, resp({ answer: 'ok', disclosedVisibility: ['PLAYER_SELF'] })).passed,
    ).toBe(true);
  });

  it('sourceUsed checks the declared authoritative source', () => {
    const r = resp({ answer: 'x', sourcesUsed: ['config.fly'] });
    expect(
      evaluateAssertion({ type: 'sourceUsed', source: 'config.fly' }, r).passed,
    ).toBe(true);
    expect(
      evaluateAssertion({ type: 'sourceUsed', source: 'wiki.fly' }, r).passed,
    ).toBe(false);
  });

  it('answered requires a non-empty answer', () => {
    expect(evaluateAssertion({ type: 'answered' }, resp({ answer: ' hi ' })).passed).toBe(true);
    expect(evaluateAssertion({ type: 'answered' }, resp({ answer: '   ' })).passed).toBe(false);
  });
});

describe('mergeContext', () => {
  it('merges sources shallowly and lets case overrides win', () => {
    const merged = mergeContext(
      { requesterVisibility: 'PUBLIC', sources: { a: '1', b: '2' } },
      { sources: { b: '3' }, isStaff: true },
    );
    expect(merged.sources).toEqual({ a: '1', b: '3' });
    expect(merged.isStaff).toBe(true);
    expect(merged.requesterVisibility).toBe('PUBLIC');
  });
});

describe('runCases', () => {
  const oneCase: EvalCase = {
    id: 't-001',
    category: 'commands',
    title: 't',
    question: 'What does /home do?',
    context: { sources: { 'command./home': 'Teleports you home.' } },
    assertions: [{ type: 'contains', value: 'Teleports' }],
  };

  it('runs cases against a SUT and reports per-case results', async () => {
    const results = await runCases(idealSystem, [oneCase]);
    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.timedOut).toBe(false);
    expect(results[0]?.assertions).toHaveLength(1);
  });

  it('fails cases whose assertions do not hold', async () => {
    const bad: EvalCase = { ...oneCase, id: 't-002', assertions: [{ type: 'contains', value: 'nope' }] };
    const results = await runCases(idealSystem, [bad]);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.assertions[0]?.passed).toBe(false);
  });

  it('marks timed-out cases and counts them as failures', async () => {
    const hanging: SystemUnderTest = () => new Promise(() => {});
    const results = await runCases(hanging, [oneCase], { timeoutMs: 50 });
    expect(results[0]?.timedOut).toBe(true);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.error).toMatch(/timeout/);
  });

  it('records SUT throws as case failures, not crashes', async () => {
    const throwing: SystemUnderTest = async () => {
      throw new Error('boom');
    };
    const results = await runCases(throwing, [oneCase]);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.error).toMatch(/boom/);
  });

  it('applies the default context under per-case overrides', async () => {
    const seen: EvalCase[] = [];
    const echo: SystemUnderTest = async (q, ctx) => {
      seen.push({ ...oneCase, context: ctx });
      return resp({ answer: 'Teleports' });
    };
    await runCases(echo, [oneCase], {
      defaultContext: { requesterVisibility: 'STAFF', isStaff: true },
    });
    expect(seen[0]?.context?.requesterVisibility).toBe('STAFF');
    expect(seen[0]?.context?.sources?.['command./home']).toBe('Teleports you home.');
  });

  it('idealSystem passes the full seed golden set', async () => {
    const results = await runCases(idealSystem, SEED_GOLDEN_CASES);
    const failed = results.filter((r) => !r.passed);
    expect(
      failed.map((f) => `${f.caseId}: ${f.assertions.filter((a) => !a.passed).map((a) => a.detail).join('; ')}`),
    ).toEqual([]);
  }, 60_000);
});
