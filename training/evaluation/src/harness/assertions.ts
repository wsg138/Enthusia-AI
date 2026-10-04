/**
 * Assertion evaluators — pure checks of an EvalResponse against Assertions.
 *
 * Each evaluator returns { passed, detail }; detail is human-readable for the
 * report. All evaluators are total functions: they never throw on
 * malformed responses (missing fields are treated as empty).
 */
import type { Assertion, EvalResponse, AssertionResult } from '../types.js';
import { canDisclose } from '../types.js';

function norm(s: string, caseSensitive?: boolean): string {
  return caseSensitive === true ? s : s.toLowerCase();
}

export function evaluateAssertion(
  assertion: Assertion,
  response: EvalResponse,
): AssertionResult {
  const answer = response.answer ?? '';
  const fail = (detail: string): AssertionResult => ({
    assertion,
    passed: false,
    detail,
  });
  const pass = (detail: string): AssertionResult => ({
    assertion,
    passed: true,
    detail,
  });

  switch (assertion.type) {
    case 'contains': {
      const ok = norm(answer, assertion.caseSensitive).includes(
        norm(assertion.value, assertion.caseSensitive),
      );
      return ok
        ? pass(`answer contains ${JSON.stringify(assertion.value)}`)
        : fail(
            assertion.message ??
              `answer does not contain ${JSON.stringify(assertion.value)}`,
          );
    }
    case 'notContains': {
      const hit = norm(answer, assertion.caseSensitive).includes(
        norm(assertion.value, assertion.caseSensitive),
      );
      return hit
        ? fail(
            assertion.message ??
              `answer must not contain ${JSON.stringify(assertion.value)}`,
          )
        : pass(`answer does not contain ${JSON.stringify(assertion.value)}`);
    }
    case 'matches': {
      let re: RegExp;
      try {
        re = new RegExp(assertion.pattern, 'i');
      } catch {
        return fail(`invalid regex pattern ${JSON.stringify(assertion.pattern)}`);
      }
      return re.test(answer)
        ? pass(`answer matches ${assertion.pattern}`)
        : fail(
            assertion.message ??
              `answer does not match ${assertion.pattern}`,
          );
    }
    case 'notMatches': {
      let re: RegExp;
      try {
        re = new RegExp(assertion.pattern, 'i');
      } catch {
        return fail(`invalid regex pattern ${JSON.stringify(assertion.pattern)}`);
      }
      return re.test(answer)
        ? fail(
            assertion.message ??
              `answer must not match ${assertion.pattern}`,
          )
        : pass(`answer does not match ${assertion.pattern}`);
    }
    case 'answerEquals': {
      const ok = answer.trim() === assertion.value.trim();
      return ok
        ? pass('answer equals expected value')
        : fail(
            assertion.message ??
              `answer differs from expected ${JSON.stringify(assertion.value)}`,
          );
    }
    case 'answered': {
      const ok = answer.trim().length > 0;
      return ok
        ? pass('system produced a non-empty answer')
        : fail(assertion.message ?? 'system produced no answer');
    }
    case 'escalatedTo': {
      const actual = response.escalated ?? 'none';
      return actual === assertion.target
        ? pass(`escalated to ${actual}`)
        : fail(
            assertion.message ??
              `expected escalation to ${assertion.target}, got ${actual}`,
          );
    }
    case 'toolCalled': {
      const calls = (response.toolCalls ?? []).filter(
        (c) => c.tool === assertion.tool,
      );
      if (calls.length === 0) {
        return fail(
          assertion.message ?? `required tool ${assertion.tool} was not called`,
        );
      }
      if (
        assertion.maxCalls !== undefined &&
        calls.length > assertion.maxCalls
      ) {
        return fail(
          `tool ${assertion.tool} called ${calls.length} times (max ${assertion.maxCalls})`,
        );
      }
      return pass(`tool ${assertion.tool} called ${calls.length}x`);
    }
    case 'toolNotCalled': {
      const calls = (response.toolCalls ?? []).filter(
        (c) => c.tool === assertion.tool,
      );
      return calls.length > 0
        ? fail(
            assertion.message ??
              `tool ${assertion.tool} must not be called (called ${calls.length}x)`,
          )
        : pass(`tool ${assertion.tool} not called`);
    }
    case 'sourceUsed': {
      const used = response.sourcesUsed ?? [];
      return used.includes(assertion.source)
        ? pass(`source ${assertion.source} used`)
        : fail(
            assertion.message ??
              `required source ${assertion.source} was not used`,
          );
    }
    case 'noDisclosureAbove': {
      const ceiling = assertion.ceiling;
      const isStaff = assertion.isStaff ?? false;
      const isSubject = assertion.isSubject ?? false;
      for (const v of response.disclosedVisibility ?? []) {
        if (!canDisclose(v, ceiling, { isStaff, isSubject })) {
          return fail(
            assertion.message ??
              `disclosed ${v} content above ${ceiling} ceiling`,
          );
        }
      }
      for (const secret of assertion.forbidden ?? []) {
        if (answer.includes(secret)) {
          return fail(
            `answer leaks forbidden content ${JSON.stringify(secret.slice(0, 40))}…`,
          );
        }
      }
      return pass(`no disclosure above ${ceiling}`);
    }
    default: {
      const exhaustive: never = assertion;
      return fail(`unknown assertion type ${(exhaustive as { type: string }).type}`);
    }
  }
}
