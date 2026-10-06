import { describe, expect, it } from 'vitest';
import {
  MAX_POLICY_CATALOG_BYTES,
  PolicyCatalogValidationError,
  parseCurrentReasonPolicyCatalog,
  policySeverityBand,
  type CurrentPolicyProvenance,
} from '../src/policy-catalog.js';

const PROVENANCE: CurrentPolicyProvenance = {
  sourceId: 'enthusia-staff-reason-policies',
  fileVersion: 'sha256:' + 'a'.repeat(64),
  observedAt: '2026-10-06T18:30:00.000Z',
  sourceStatus: 'CURRENT',
};

const POLICY = [
  'version: "2026-10-06.1"',
  'defaults:',
  '  reportable: true',
  'reasons:',
  '  - id: spam.low-level',
  '    family: spam',
  '    display-name: Low-level chat spam',
  '    severity: 10',
  '    examples: ["Repeated characters"]',
  '    ladder:',
  '      - label: Warning',
  '        sanctions:',
  '          - { type: WARNING, duration: instant }',
  '  - id: exploit.major-abuse',
  '    family: exploit',
  '    display-name: Major exploit abuse',
  '    severity: 85',
  '    ladder:',
  '      - label: Permanent ban',
  '        sanctions:',
  '          - { type: NETWORK_BAN, duration: permanent }',
  '  - id: internal.not-reportable',
  '    family: internal',
  '    display-name: Internal-only reason',
  '    severity: 100',
  '    reportable: false',
  '    ladder:',
  '      - label: Secret action',
  '        sanctions:',
  '          - { type: NETWORK_BAN, duration: permanent }',
].join('\n')

describe('parseCurrentReasonPolicyCatalog', () => {
  it('projects current reportable reasons without punishment ladders', () => {
    const catalog = parseCurrentReasonPolicyCatalog(POLICY, PROVENANCE);

    expect(catalog.policyVersion).toBe('2026-10-06.1');
    expect(catalog.provenance).toEqual(PROVENANCE);
    expect(catalog.rules).toEqual([
      {
        id: 'spam.low-level',
        family: 'spam',
        label: 'Low-level chat spam',
        severity: 10,
        severityBand: 'low',
        examples: ['Repeated characters'],
      },
      {
        id: 'exploit.major-abuse',
        family: 'exploit',
        label: 'Major exploit abuse',
        severity: 85,
        severityBand: 'high',
        examples: [],
      },
    ]);

    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain('ladder');
    expect(serialized).not.toContain('NETWORK_BAN');
    expect(serialized).not.toContain('Permanent ban');
    expect(serialized).not.toContain('internal.not-reportable');
  });

  it('maps numeric policy severity into bounded concern severity', () => {
    expect(policySeverityBand(0)).toBe('low');
    expect(policySeverityBand(35)).toBe('medium');
    expect(policySeverityBand(65)).toBe('high');
    expect(policySeverityBand(90)).toBe('critical');
    expect(() => policySeverityBand(101)).toThrow(
      PolicyCatalogValidationError,
    );
  });

  it('rejects stale or unhashed provenance', () => {
    const stale = {
      ...PROVENANCE,
      sourceStatus: 'STALE',
    } as unknown as CurrentPolicyProvenance;
    expect(() => parseCurrentReasonPolicyCatalog(POLICY, stale)).toThrow(
      /CURRENT source/,
    );

    expect(() =>
      parseCurrentReasonPolicyCatalog(POLICY, {
        ...PROVENANCE,
        fileVersion: 'git-main',
      }),
    ).toThrow(/SHA-256/);
  });

  it('rejects duplicate reason ids instead of silently choosing one', () => {
    const duplicated = POLICY.replace(
      '  - id: exploit.major-abuse',
      `  - id: spam.low-level
    family: spam
    display-name: Duplicate spam
    severity: 20
  - id: exploit.major-abuse`,
    );
    expect(() =>
      parseCurrentReasonPolicyCatalog(duplicated, PROVENANCE),
    ).toThrow(/duplicate reason id/);
  });

  it('rejects duplicate YAML mapping keys', () => {
    const duplicateVersion = POLICY.replace(
      'version: "2026-10-06.1"',
      'version: "2026-10-06.1"\nversion: "other"',
    );
    expect(() =>
      parseCurrentReasonPolicyCatalog(duplicateVersion, PROVENANCE),
    ).toThrow(/not valid YAML/);
  });

  it('rejects oversized policy input before parsing', () => {
    const oversized = 'x'.repeat(MAX_POLICY_CATALOG_BYTES + 1);
    expect(() =>
      parseCurrentReasonPolicyCatalog(oversized, PROVENANCE),
    ).toThrow(/size bound/);
  });

  it('requires at least one reportable reason', () => {
    const none = [
      'version: "v1"',
      'defaults:',
      '  reportable: false',
      'reasons:',
      '  - id: internal.only',
      '    family: internal',
      '    display-name: Internal only',
      '    severity: 50',
    ].join('\n')
    expect(() => parseCurrentReasonPolicyCatalog(none, PROVENANCE)).toThrow(
      /no reportable reasons/,
    );
  });
});
