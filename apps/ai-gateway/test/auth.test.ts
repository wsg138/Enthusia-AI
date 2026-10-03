import { describe, expect, it } from 'vitest';
import { EnthusiaError, Visibility, type ActorType } from '@enthusia/contracts';
import {
  ACTOR_MAX_CEILING,
  authenticateServiceKey,
  extractBearerToken,
  resolveVisibilityCeiling,
  validateActorSurface,
} from '../src/auth.js';
import { loadGatewayConfig } from '../src/config.js';
import { testConfig } from './helpers.js';

const TRACE = '123e4567-e89b-12d3-a456-426614174000';

function configWith(overrides: Record<string, string> = {}) {
  return testConfig({ ENTHUSIA_GATEWAY_API_KEYS: 'key-one,key-two', ...overrides });
}

describe('production authentication configuration', () => {
  it('fails closed when production has no service API key', () => {
    expect(() =>
      loadGatewayConfig({
        NODE_ENV: 'production',
      }),
    ).toThrow(/ENTHUSIA_GATEWAY_API_KEYS/);
  });

  it('allows production startup when at least one service API key is configured', () => {
    const config = loadGatewayConfig({
      NODE_ENV: 'production',
      ENTHUSIA_GATEWAY_API_KEYS: 'prod-service-key',
    });
    expect(config.apiKeys).toEqual(['prod-service-key']);
  });
});

describe('extractBearerToken', () => {
  it('extracts a Bearer token', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
    expect(extractBearerToken('Bearer   abc123  ')).toBe('abc123');
  });

  it('returns undefined for missing or malformed headers', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('Basic abc123')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
  });

  it('uses the first value when the header repeats', () => {
    expect(extractBearerToken(['Bearer first', 'Bearer second'])).toBe('first');
  });
});

describe('authenticateServiceKey', () => {
  it('is a no-op when no keys are configured (dev/test mode)', () => {
    const config = testConfig();
    expect(config.apiKeys).toEqual([]);
    expect(() => authenticateServiceKey({}, config, TRACE)).not.toThrow();
  });

  it('accepts any configured key', () => {
    const config = configWith();
    expect(() =>
      authenticateServiceKey({ authorization: 'Bearer key-one' }, config, TRACE),
    ).not.toThrow();
    expect(() =>
      authenticateServiceKey({ authorization: 'Bearer key-two' }, config, TRACE),
    ).not.toThrow();
  });

  it('rejects missing, wrong, and malformed credentials with 401', () => {
    const config = configWith();
    for (const headers of [
      {},
      { authorization: 'Bearer wrong-key' },
      { authorization: 'Basic key-one' },
      // Prefix of a real key must not pass (length check before timingSafeEqual).
      { authorization: 'Bearer key-' },
    ]) {
      let err: unknown;
      try {
        authenticateServiceKey(headers, config, TRACE);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EnthusiaError);
      const authErr = err as EnthusiaError;
      expect(authErr.statusCode).toBe(401);
      expect(authErr.code).toBe('AUTHENTICATION_FAILED');
      expect(authErr.traceId).toBe(TRACE);
      // The key value must never leak into the error.
      expect(authErr.message).not.toContain('key-one');
      expect(JSON.stringify(authErr.toJSON())).not.toContain('key-one');
    }
  });
});

describe('validateActorSurface', () => {
  it('accepts allowlisted surface/actor combinations', () => {
    const config = testConfig();
    expect(() =>
      validateActorSurface(
        { surface: 'discord', actor: { id: 'u1', type: 'player' } },
        config,
        TRACE,
      ),
    ).not.toThrow();
  });

  it('rejects surfaces outside the allowlist with 403', () => {
    const config = testConfig({ ENTHUSIA_GATEWAY_ALLOWED_SURFACES: 'discord' });
    let err: unknown;
    try {
      validateActorSurface(
        { surface: 'minecraft', actor: { id: 'u1', type: 'player' } },
        config,
        TRACE,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnthusiaError);
    expect((err as EnthusiaError).statusCode).toBe(403);
  });

  it('rejects actor types outside the allowlist with 403', () => {
    const config = testConfig({ ENTHUSIA_GATEWAY_ALLOWED_ACTOR_TYPES: 'player,staff' });
    let err: unknown;
    try {
      validateActorSurface(
        { surface: 'discord', actor: { id: 'sys', type: 'system' } },
        config,
        TRACE,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnthusiaError);
    expect((err as EnthusiaError).statusCode).toBe(403);
  });
});

describe('resolveVisibilityCeiling', () => {
  const cases: Array<[ActorType, Visibility, boolean]> = [
    ['player', Visibility.PUBLIC, true],
    ['player', Visibility.PLAYER_SELF, true],
    ['player', Visibility.STAFF, false],
    ['staff', Visibility.STAFF, true],
    ['staff', Visibility.MANAGEMENT, false],
    ['system', Visibility.SYSTEM_INTERNAL, true],
    ['system', Visibility.MANAGEMENT, true],
    ['unknown', Visibility.PUBLIC, true],
    ['unknown', Visibility.PLAYER_SELF, false],
    // SECRET_DENY is never a usable ceiling.
    ['player', Visibility.SECRET_DENY, false],
    ['staff', Visibility.SECRET_DENY, false],
    ['system', Visibility.SECRET_DENY, false],
  ];

  for (const [actorType, requested, allowed] of cases) {
    it(`${actorType} requesting ${requested} → ${allowed ? 'allowed' : 'denied'}`, () => {
      if (allowed) {
        expect(resolveVisibilityCeiling(actorType, requested, TRACE)).toBe(requested);
      } else {
        expect(() => resolveVisibilityCeiling(actorType, requested, TRACE)).toThrowError(
          expect.objectContaining({ statusCode: 403 }),
        );
      }
    });
  }

  it('documents the actor → max-ceiling policy', () => {
    expect(ACTOR_MAX_CEILING).toEqual({
      player: Visibility.PLAYER_SELF,
      staff: Visibility.STAFF,
      system: Visibility.SYSTEM_INTERNAL,
      unknown: Visibility.PUBLIC,
    });
  });
});
