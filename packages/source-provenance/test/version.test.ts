import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  computeContentHash,
  describeVersion,
  isVersionChanged,
  normalizeVersion,
  versionKind,
} from '../src/version.js';

describe('versionKind', () => {
  it('classifies git SHAs, SHA-256 digests, semver, timestamps, and opaque strings', () => {
    expect(versionKind('a'.repeat(40))).toBe('git-sha');
    expect(versionKind('b'.repeat(64))).toBe('sha256');
    expect(versionKind('1.2.3')).toBe('semver');
    expect(versionKind('v2.0.0-rc.1')).toBe('semver');
    expect(versionKind('2026-10-03T12:00:00Z')).toBe('timestamp');
    expect(versionKind('build-4821')).toBe('opaque');
  });
});

describe('normalizeVersion', () => {
  it('trims whitespace', () => {
    expect(normalizeVersion('  abc123  ')).toBe('abc123');
  });

  it('lower-cases hex fingerprints so equivalent encodings compare equal', () => {
    expect(normalizeVersion('A'.repeat(40))).toBe('a'.repeat(40));
  });

  it('leaves non-hex versions verbatim (except trimming)', () => {
    expect(normalizeVersion('Build-4821')).toBe('Build-4821');
  });
});

describe('compareVersions', () => {
  it('treats identical versions as SAME', () => {
    expect(compareVersions('abc123', 'abc123')).toBe('SAME');
  });

  it('treats differently-cased hex fingerprints as SAME (no phantom supersession)', () => {
    const sha = '9F2C4A1B'.padEnd(40, '0');
    expect(compareVersions(sha, sha.toLowerCase())).toBe('SAME');
  });

  it('treats any other difference as DIFFERENT (a change)', () => {
    expect(compareVersions('aaa', 'aab')).toBe('DIFFERENT');
    expect(compareVersions('1.2.3', '1.2.4')).toBe('DIFFERENT');
  });

  it('isVersionChanged is the boolean form', () => {
    expect(isVersionChanged('x', 'x')).toBe(false);
    expect(isVersionChanged('x', 'y')).toBe(true);
  });
});

describe('computeContentHash', () => {
  it('is deterministic and content-sensitive (SHA-256)', () => {
    const a = computeContentHash('config: v1');
    const b = computeContentHash('config: v1');
    const c = computeContentHash('config: v2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });

  it('accepts binary content', () => {
    expect(computeContentHash(new Uint8Array([1, 2, 3]))).toHaveLength(64);
  });
});

describe('describeVersion', () => {
  it('carries the raw value plus its kind', () => {
    expect(describeVersion('1.2.3')).toEqual({ value: '1.2.3', kind: 'semver' });
  });
});
