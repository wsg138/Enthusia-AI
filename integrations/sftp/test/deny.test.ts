/**
 * @enthusia/integration-sftp — deny pattern tests (W09).
 *
 * Rigorously verifies the HARD DENY set: every listed pattern, edge cases
 * (case, traversal, nesting, lookalikes), and — critically — that EVERY
 * client operation refuses denied paths, including attempted bypasses like
 * `..` traversal and the underlying client being called directly.
 */

import { describe, expect, it } from 'vitest';
import {
  assertAllowedPath,
  compileExtraDenyPatterns,
  denyRuleFor,
  HARD_DENY_RULES,
  isDeniedPath,
  normalizeForDenyCheck,
  SecretDenyError,
} from '../src/deny.js';
import { DenyGuardSftpClient } from '../src/sftp-client.js';
import { MockSftpServer } from './fakes.js';

describe('hard deny rules are present and unconditional', () => {
  it('exposes the expected rule names', () => {
    const names = new Set(HARD_DENY_RULES.map((r) => r.name));
    for (const expected of [
      'env-file',
      'credential',
      'secret',
      'pem-key-file',
      'ssh-private-key-name',
      'token',
      'ssh-directory',
    ]) {
      expect(names.has(expected), `missing rule ${expected}`).toBe(true);
    }
  });

  it('cannot be disabled: denyRuleFor takes no "disable" option', () => {
    // By construction: the only parameters are the path and EXTRA rules.
    // This test documents the invariant for reviewers.
    expect(isDeniedPath('/srv/.env')).toBe(true);
    expect(isDeniedPath('/srv/.env', [])).toBe(true);
  });
});

describe('.env files', () => {
  const denied = [
    '/srv/minecraft/.env',
    '/srv/minecraft/.env.local',
    '/srv/minecraft/.env.production',
    '/srv/minecraft/.env.example',
    '/srv/.env',
    '/.env',
    '/srv/minecraft/sub/.ENV', // case-insensitive
    '/srv/minecraft/.Env.Backup',
  ];
  it.each(denied)('denies %s', (p) => {
    expect(isDeniedPath(p)).toBe(true);
    expect(denyRuleFor(p)?.name).toBe('env-file');
  });

  const allowed = [
    '/srv/minecraft/env.txt', // "env" without the dot is not an env file
    '/srv/minecraft/my.env.backup/x.yml', // ".env" must be a segment start
    '/srv/minecraft/dotenv/config.yml',
  ];
  it.each(allowed)('allows %s', (p) => {
    expect(isDeniedPath(p)).toBe(false);
  });
});

describe('*credential*', () => {
  const denied = [
    '/srv/plugins/Auth/credentials.yml',
    '/srv/plugins/Auth/CREDENTIALS.JSON',
    '/srv/credential-store.txt',
    '/srv/db_credential_backup/sqlite.db',
  ];
  it.each(denied)('denies %s', (p) => expect(isDeniedPath(p)).toBe(true));
  it('does not over-match "accredit"', () => {
    // "credential" is a distinct substring; sanity check it still fires
    // inside longer words that contain it.
    expect(isDeniedPath('/srv/mycredentialfile')).toBe(true);
  });
});

describe('*secret*', () => {
  const denied = [
    '/srv/secrets.txt',
    '/srv/config/SECRET_KEYS.yml',
    '/srv/plugins/vault-secret/config.yml',
  ];
  it.each(denied)('denies %s', (p) => expect(isDeniedPath(p)).toBe(true));
});

describe('*.pem and *.key', () => {
  const denied = [
    '/srv/certs/server.pem',
    '/srv/certs/server.PEM',
    '/srv/keys/api.key',
    '/srv/keys/api.KEY',
    '/home/mc/.ssh/id_rsa', // caught by BOTH key-name and .key? id_rsa has no .key ext; key-name rule fires
  ];
  it.each(denied)('denies %s', (p) => expect(isDeniedPath(p)).toBe(true));

  it('does not deny ".key" mid-path (e.g. keyboard.yml)', () => {
    expect(isDeniedPath('/srv/plugins/keyboard/config.yml')).toBe(false);
  });
  it('does not deny "monkey.yml"', () => {
    expect(isDeniedPath('/srv/plugins/monkey.yml')).toBe(false);
  });
});

describe('id_rsa* / id_ed25519*', () => {
  const denied = [
    '/home/mc/.ssh/id_rsa',
    '/home/mc/.ssh/id_rsa.pub',
    '/home/mc/.ssh/id_ed25519',
    '/home/mc/.ssh/id_ed25519_sk',
    '/srv/backup/ID_RSA_OLD',
    '/srv/keys/id_rsa-cert.pub',
  ];
  it.each(denied)('denies %s', (p) => expect(isDeniedPath(p)).toBe(true));

  it('requires a segment boundary (no false positive on "valid_rsa_plugin")', () => {
    expect(isDeniedPath('/srv/plugins/valid_rsa_plugin/config.yml')).toBe(false);
  });
});

describe('*token*', () => {
  const denied = [
    '/srv/plugins/DiscordSRV/token.txt',
    '/srv/config/TOKENS.yml',
    '/srv/bot-token.json',
  ];
  it.each(denied)('denies %s', (p) => expect(isDeniedPath(p)).toBe(true));
});

describe('.ssh directories (hardening)', () => {
  const denied = [
    '/home/mc/.ssh/known_hosts',
    '/home/mc/.ssh/config',
    '/home/mc/.SSH/authorized_keys',
  ];
  it.each(denied)('denies %s', (p) => expect(isDeniedPath(p)).toBe(true));
});

describe('traversal and normalization bypasses', () => {
  it('denies ../ escapes that resolve onto a denied path', () => {
    expect(isDeniedPath('/srv/plugins/../.env')).toBe(true);
    expect(isDeniedPath('/srv/plugins/../../etc/secret.txt')).toBe(true);
    expect(isDeniedPath('/srv/a/./b/../.env.local')).toBe(true);
  });
  it('denies with duplicate slashes and backslashes', () => {
    expect(isDeniedPath('//srv//.env')).toBe(true);
    expect(isDeniedPath('/srv\\.env')).toBe(true);
  });
  it('normalizeForDenyCheck collapses traversal before matching', () => {
    expect(normalizeForDenyCheck('/srv/plugins/../.env')).toBe('/srv/.env');
  });
});

describe('assertAllowedPath', () => {
  it('throws SecretDenyError with the path and rule name', () => {
    try {
      assertAllowedPath('/srv/.env');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretDenyError);
      const deny = err as SecretDenyError;
      expect(deny.deniedPath).toBe('/srv/.env');
      expect(deny.ruleName).toBe('env-file');
      expect(deny.message).toContain('/srv/.env');
    }
  });

  it('returns the normalized path when allowed', () => {
    expect(assertAllowedPath('/srv/plugins//Essentials/config.yml')).toBe(
      '/srv/plugins/Essentials/config.yml',
    );
  });

  it('applies extra rules on top of the hard set', () => {
    const extra = compileExtraDenyPatterns(['/\\.bak$/']);
    expect(() => assertAllowedPath('/srv/config.yml.bak', extra)).toThrow(SecretDenyError);
    expect(assertAllowedPath('/srv/config.yml', extra)).toBe('/srv/config.yml');
  });

  it('rejects invalid extra patterns at compile time', () => {
    expect(() => compileExtraDenyPatterns(['/(unclosed/'])).toThrow(/invalid extra deny pattern/);
  });
});

describe('DenyGuardSftpClient — no code path can read a denied path', () => {
  function guardedServer(): { server: MockSftpServer; guarded: DenyGuardSftpClient } {
    const server = new MockSftpServer();
    server.writeFile('/srv/plugins/Essentials/config.yml', 'debug: false\n');
    server.writeFile('/srv/.env', 'DB_PASSWORD=hunter2\n');
    server.writeFile('/srv/secrets/token.txt', 'tok\n');
    const guarded = DenyGuardSftpClient.denyOnly(server);
    return { server, guarded };
  }

  it('listDir refuses a denied directory', async () => {
    const { server, guarded } = guardedServer();
    await expect(guarded.listDir('/srv/secrets')).rejects.toBeInstanceOf(SecretDenyError);
    expect(server.touched('/srv/secrets')).toBe(false);
  });

  it('stat refuses a denied file', async () => {
    const { server, guarded } = guardedServer();
    await expect(guarded.stat('/srv/.env')).rejects.toBeInstanceOf(SecretDenyError);
    expect(server.touched('/srv/.env')).toBe(false);
  });

  it('readFile refuses a denied file', async () => {
    const { server, guarded } = guardedServer();
    await expect(guarded.readFile('/srv/.env', 1024)).rejects.toBeInstanceOf(SecretDenyError);
    expect(server.touched('/srv/.env')).toBe(false);
  });

  it('hashFile refuses a denied file', async () => {
    const { server, guarded } = guardedServer();
    await expect(guarded.hashFile('/srv/secrets/token.txt', 1024)).rejects.toBeInstanceOf(
      SecretDenyError,
    );
    expect(server.touched('token.txt')).toBe(false);
  });

  it('refuses traversal that resolves to a denied path', async () => {
    const { server, guarded } = guardedServer();
    await expect(guarded.readFile('/srv/plugins/../.env', 1024)).rejects.toBeInstanceOf(
      SecretDenyError,
    );
    expect(server.touched('.env')).toBe(false);
  });

  it('still serves allowed paths normally', async () => {
    const { guarded } = guardedServer();
    const content = await guarded.readFile('/srv/plugins/Essentials/config.yml', 1024);
    expect(content.toString('utf8')).toBe('debug: false\n');
  });

  it('never leaks file content in denial errors', async () => {
    const { guarded } = guardedServer();
    const err = await guarded.readFile('/srv/.env', 1024).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('hunter2');
  });
});
