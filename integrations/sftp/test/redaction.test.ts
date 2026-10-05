import { expect, it } from 'vitest';
import {
  REDACTED_VALUE,
  sanitizeModelVisibleText,
} from '../src/redaction.js';

  it('redacts common scalar credential fields while preserving useful config', () => {
    const out = sanitizeModelVisibleText(
      [
        'feature: true',
        'discordToken: TEST_ONLY_DISCORD',
        'webhookUrl: https://example.invalid/secret',
        'databaseUrl: jdbc:mysql://db.invalid/app?password=TEST_ONLY',
      ].join('\n'),
      '/srv/plugin/config.yml',
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toContain('feature: true');
    expect(out.text).not.toContain('TEST_ONLY_DISCORD');
    expect(out.text).not.toContain('example.invalid/secret');
    expect(out.text).not.toContain('jdbc:mysql');
    expect(out.text.split(REDACTED_VALUE).length - 1).toBeGreaterThanOrEqual(3);
  });

  it('redacts an entire nested YAML secret container', () => {
    const out = sanitizeModelVisibleText(
      [
        'database:',
        '  host: db.example.invalid',
        '  password:',
        '    value: TEST_ONLY_NESTED_SECRET',
        '    rotate: never',
        'feature:',
        '  enabled: true',
      ].join('\n'),
      '/srv/plugin/config.yml',
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toContain('password: ' + REDACTED_VALUE);
    expect(out.text).not.toContain('TEST_ONLY_NESTED_SECRET');
    expect(out.text).not.toContain('rotate: never');
    expect(out.text).toContain('feature:');
    expect(out.text).toContain('enabled: true');
  });

  it('redacts JSON credential objects without serializing their children', () => {
    const out = sanitizeModelVisibleText(
      JSON.stringify({
        feature: true,
        credentials: {
          username: 'service-user',
          token: 'TEST_ONLY_TOKEN',
        },
      }),
      '/srv/plugin/config.json',
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toContain('"feature": true');
    expect(out.text).toContain('"credentials": "' + REDACTED_VALUE + '"');
    expect(out.text).not.toContain('service-user');
    expect(out.text).not.toContain('TEST_ONLY_TOKEN');
  });

  it('denies opaque private-key material even under an innocent field name', () => {
    const out = sanitizeModelVisibleText(
      [
        'notes: |',
        '  -----BEGIN OPENSSH PRIVATE KEY-----',
        '  TEST_ONLY_PRIVATE_KEY_BODY',
      ].join('\n'),
      '/srv/plugin/config.yml',
    );

    expect(out).toEqual({ ok: false, reason: 'secret-content' });
  });
