import { describe, expect, it } from 'vitest';
import { normalizeClassification } from '../src/intent.js';

describe('normalizeClassification adaptive fields', () => {
  it('keeps background claims only when they are verified-answer claims', () => {
    const result = normalizeClassification({
      requestClass: 'simple',
      summary: '  explain reputation  ',
      claims: [
        ' reputation is a feedback system ',
        'Good Stall meaning',
        'Good Stall meaning',
      ],
      backgroundClaims: [
        'reputation is a feedback system',
        'invented background not in claims',
        '   ',
      ],
      needsFamiliarityContext: true,
      familiarityTopic: '  reputation   system ',
      needsPrivateContext: false,
      securitySensitive: false,
    });

    expect(result.claims).toEqual([
      'reputation is a feedback system',
      'Good Stall meaning',
    ]);
    expect(result.backgroundClaims).toEqual([
      'reputation is a feedback system',
    ]);
    expect(result.needsFamiliarityContext).toBe(true);
    expect(result.familiarityTopic).toBe('reputation system');
  });

  it('does not invent adaptive fields when the reasoner did not request them', () => {
    const result = normalizeClassification({
      requestClass: 'simple',
      summary: 'server ip',
      claims: ['server IP'],
      needsPrivateContext: false,
      securitySensitive: false,
    });
    expect(result.backgroundClaims).toBeUndefined();
    expect(result.needsFamiliarityContext).toBeUndefined();
    expect(result.familiarityTopic).toBeUndefined();
  });
});
