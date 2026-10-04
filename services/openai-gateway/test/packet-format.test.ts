import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import {
  estimatePromptTokens,
  estimateTokens,
  formatEscalationMessages,
  MAX_EVIDENCE_VALUE_CHARS,
} from '../src/packet-format.js';
import { makePacket } from './helpers.js';

describe('formatEscalationMessages', () => {
  it('emits system + user messages covering every §22.2 field', () => {
    const [system, user] = formatEscalationMessages(makePacket(), 'coding');
    expect(system?.role).toBe('system');
    expect(user?.role).toBe('user');

    const body = user?.content ?? '';
    for (const needle of [
      'Why does /staff vanish break on the hub server?', // question
      'Diagnose the vanish failure on hub', // goal
      'engineering', // request class
      'wsg138/EnthusiaStaff', // repositories
      'StaffMode.java', // files
      'abc123', // SHAs
      'vanish listener registered on hub', // evidence
      'github.code_search', // evidence tool
      'Why does the vanish listener not fire', // unresolved questions
      'No production writes', // constraints
      'staff-42', // authorization
      'Diagnosis and a concrete code change proposal', // expected output
      'packet:trace-1', // packet ref
    ]) {
      expect(body).toContain(needle);
    }
  });

  it('binds the stronger model to constraints, secrecy, and coding authority', () => {
    const [system] = formatEscalationMessages(makePacket(), 'investigation');
    const text = system?.content ?? '';
    expect(text).toContain('STAFF'); // visibility ceiling
    expect(text).toContain('SECRET_DENY');
    expect(text).toContain('must NOT merge');
    expect(text).toContain('Expected output');
  });

  it('notes redacted evidence and never embeds SECRET_DENY values', () => {
    const packet = makePacket({
      redactedEvidenceCount: 2,
      toolEvidence: [
        {
          id: 'secret',
          claim: 'secret claim',
          value: 'TOP-SECRET-VALUE-12345',
          toolName: 'db.query',
          source: 'db:players',
          visibility: Visibility.SECRET_DENY,
          verificationTier: 'tool-verified',
        },
      ],
    });
    const [, user] = formatEscalationMessages(packet, 'analysis');
    const body = user?.content ?? '';
    expect(body).not.toContain('TOP-SECRET-VALUE-12345');
    expect(body).toContain('2 evidence item(s) were redacted');
  });

  it('truncates huge evidence values with a marker', () => {
    const big = 'x'.repeat(MAX_EVIDENCE_VALUE_CHARS) + 'TAIL-MARKER' + 'y'.repeat(489);
    const packet = makePacket({
      toolEvidence: [
        {
          id: 'big',
          claim: 'huge log',
          value: big,
          toolName: 'logs.read',
          source: 'logs:hub',
          visibility: Visibility.STAFF,
          verificationTier: 'tool-verified',
        },
      ],
    });
    const [, user] = formatEscalationMessages(packet, 'debugging');
    const body = user?.content ?? '';
    expect(body).toContain('[truncated: 500 more chars]');
    expect(body).not.toContain('TAIL-MARKER');
  });
});

describe('estimateTokens', () => {
  it('estimates roughly chars/4 with a floor of 1', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('sums messages for the prompt estimate', () => {
    const messages = formatEscalationMessages(makePacket(), 'coding');
    const estimate = estimatePromptTokens(messages);
    expect(estimate).toBeGreaterThan(100);
    expect(Number.isInteger(estimate)).toBe(true);
  });
});
