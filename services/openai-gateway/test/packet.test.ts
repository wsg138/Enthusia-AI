import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import {
  assertValidInvestigationPacket,
  InvalidPacketError,
  validateInvestigationPacket,
} from '../src/packet.js';
import { makePacket } from './helpers.js';

describe('validateInvestigationPacket', () => {
  it('accepts a well-formed §22.2 packet', () => {
    expect(validateInvestigationPacket(makePacket())).toEqual([]);
  });

  it('reports every missing §22.2 field', () => {
    const issues = validateInvestigationPacket({
      packetRef: 'packet:x',
      traceId: 'x',
    });
    const fields = issues.map((i) => i.field);
    expect(fields).toContain('userQuestion');
    expect(fields).toContain('goal');
    expect(fields).toContain('requestClass');
    expect(fields).toContain('relevantRepositories');
    expect(fields).toContain('relevantFiles');
    expect(fields).toContain('currentShas');
    expect(fields).toContain('toolEvidence');
    expect(fields).toContain('attemptedDiagnosis');
    expect(fields).toContain('unresolvedQuestions');
    expect(fields).toContain('constraints');
    expect(fields).toContain('expectedOutput');
    expect(fields).toContain('redactedEvidenceCount');
    expect(fields).toContain('authorization');
    expect(issues.length).toBeGreaterThan(5);
  });

  it('rejects an empty user question', () => {
    const issues = validateInvestigationPacket(
      makePacket({ userQuestion: '' }),
    );
    expect(issues.some((i) => i.field === 'userQuestion')).toBe(true);
  });

  it('rejects malformed evidence items', () => {
    const issues = validateInvestigationPacket(
      makePacket({
        toolEvidence: [
          {
            id: 'bad',
            claim: 'x',
            value: 'y',
            toolName: 't',
            source: 's',
            // missing visibility + verificationTier
          } as never,
        ],
      }),
    );
    expect(issues.some((i) => i.field === 'toolEvidence')).toBe(true);
  });

  it('rejects an invalid visibility ceiling', () => {
    const issues = validateInvestigationPacket(
      makePacket({
        authorization: {
          actorId: 'a',
          actorKind: 'staff',
          visibilityCeiling: 'EVERYONE' as never,
        },
      }),
    );
    expect(
      issues.some((i) => i.field === 'authorization.visibilityCeiling'),
    ).toBe(true);
  });

  it('rejects a non-object root', () => {
    expect(validateInvestigationPacket(null)).toHaveLength(1);
    expect(validateInvestigationPacket('nope')).toHaveLength(1);
  });

  it('accepts SECRET_DENY-marked evidence structurally (redaction is W12/format-time)', () => {
    const packet = makePacket({
      toolEvidence: [
        {
          id: 'secret',
          claim: 'secret claim',
          value: 'secret value',
          toolName: 'db.query',
          source: 'db:players',
          visibility: Visibility.SECRET_DENY,
          verificationTier: 'tool-verified',
        },
      ],
    });
    expect(validateInvestigationPacket(packet)).toEqual([]);
  });
});

describe('assertValidInvestigationPacket', () => {
  it('does not throw for a valid packet', () => {
    expect(() => assertValidInvestigationPacket(makePacket())).not.toThrow();
  });

  it('throws InvalidPacketError carrying all issues', () => {
    try {
      assertValidInvestigationPacket(makePacket({ goal: '' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPacketError);
      const invalid = error as InvalidPacketError;
      expect(invalid.issues.some((i) => i.field === 'goal')).toBe(true);
      expect(invalid.message).toContain('goal');
    }
  });
});
