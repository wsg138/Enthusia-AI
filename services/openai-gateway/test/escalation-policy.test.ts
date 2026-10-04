import { describe, expect, it } from 'vitest';
import {
  authorizeEscalation,
  classifyEscalationKind,
  EscalationDeniedError,
} from '../src/escalation-policy.js';
import { DEFAULT_MODEL_SELECTION } from '../src/models.js';
import { makePacket } from './helpers.js';

const base = {
  packet: makePacket(),
  escalationsUsedForTrace: 0,
  maxEscalationsPerRequest: 3,
  modelSelection: DEFAULT_MODEL_SELECTION,
};

describe('authorizeEscalation', () => {
  it('authorizes an openai-targeted escalation with kind + model', () => {
    const authorized = authorizeEscalation({
      ...base,
      decision: { target: 'openai', reason: 'engineering request', packetRef: 'packet:trace-1' },
    });
    expect(authorized.kind).toBe('coding');
    expect(authorized.model).toBe(DEFAULT_MODEL_SELECTION.coding);
    expect(authorized.trigger).toBe('engineering request');
  });

  it('denies coding escalation from player chat', () => {
    const packet = makePacket({
      authorization: {
        actorId: 'player-1',
        actorKind: 'player',
        visibilityCeiling: makePacket().authorization.visibilityCeiling,
      },
    });
    expect(() =>
      authorizeEscalation({
        ...base,
        packet,
        decision: { target: 'openai', reason: 'engineering request', packetRef: packet.packetRef },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'coding_actor_not_authorized' }),
    );
  });

  it('denies non-openai targets (staff/owner stay human-side)', () => {
    for (const target of ['staff', 'owner'] as const) {
      expect(() =>
        authorizeEscalation({
          ...base,
          decision: { target, reason: 'human review' },
        }),
      ).toThrowError(EscalationDeniedError);
      try {
        authorizeEscalation({ ...base, decision: { target, reason: 'x' } });
      } catch (error) {
        expect((error as EscalationDeniedError).code).toBe('not_openai_target');
      }
    }
  });

  it('denies packetRef mismatches between decision and packet', () => {
    try {
      authorizeEscalation({
        ...base,
        decision: { target: 'openai', reason: 'x', packetRef: 'packet:other' },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EscalationDeniedError);
      expect((error as EscalationDeniedError).code).toBe('packet_ref_mismatch');
    }
  });

  it('enforces the §37 per-request escalation call cap', () => {
    try {
      authorizeEscalation({
        ...base,
        escalationsUsedForTrace: 3,
        decision: { target: 'openai', reason: 'x' },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as EscalationDeniedError).code).toBe(
        'max_escalations_per_request',
      );
    }
    // One below the cap is fine.
    expect(
      authorizeEscalation({
        ...base,
        escalationsUsedForTrace: 2,
        decision: { target: 'openai', reason: 'x' },
      }).kind,
    ).toBe('coding');
  });
});

describe('classifyEscalationKind', () => {
  it('maps engineering request class to coding', () => {
    expect(classifyEscalationKind(makePacket(), 'r')).toBe('coding');
  });

  it('detects debugging from repeated failures', () => {
    const packet = makePacket({
      requestClass: 'support',
      goal: 'fix the crash',
      unresolvedQuestions: ['local tools failed repeatedly, need alternate strategy'],
    });
    expect(classifyEscalationKind(packet, 'repeated failures')).toBe('debugging');
  });

  it('detects architecture from refactor language', () => {
    const packet = makePacket({
      requestClass: 'support',
      goal: 'architectural refactor of the vanish system',
    });
    expect(classifyEscalationKind(packet, 'r')).toBe('architecture');
  });

  it('defaults multi-repo, non-engineering work to investigation', () => {
    const packet = makePacket({
      requestClass: 'support',
      goal: 'compare configs across repos',
      relevantRepositories: ['wsg138/A', 'wsg138/B'],
    });
    expect(classifyEscalationKind(packet, 'r')).toBe('investigation');
  });
});
