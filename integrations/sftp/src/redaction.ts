/**
 * Secret-aware sanitization for model-visible server text.
 *
 * Structured configuration may describe that an integration exists, but
 * credential values never leave the gateway. High-risk opaque secret material
 * that cannot be attributed to a field is denied entirely.
 */

import posixPath from 'node:path/posix';

export const REDACTED_VALUE = '[REDACTED]';

const DIRECT_SECRET_KEYS = new Set([
  'password',
  'passwd',
  'passphrase',
  'token',
  'authtoken',
  'authenticationtoken',
  'accesstoken',
  'refreshtoken',
  'apitoken',
  'apikey',
  'clientsecret',
  'webhooksecret',
  'forwardingsecret',
  'sharedsecret',
  'privatekey',
  'secretkey',
  'sftpcredential',
  'sftppassword',
  'databaseurl',
  'jdbcurl',
  'dsn',
  'connectionstring',
]);

const DATABASE_PARENTS = new Set([
  'database',
  'db',
  'mysql',
  'mariadb',
  'postgres',
  'postgresql',
  'redis',
  'mongodb',
  'mongo',
]);

const CONNECTION_KEYS = new Set([
  'url',
  'uri',
  'dsn',
  'jdbcurl',
  'connection',
  'connectionstring',
  'databaseurl',
]);

const HIGH_RISK_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /-----BEGIN ENCRYPTED PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bmfa\.[A-Za-z0-9_-]{20,}\b/,
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(path: readonly string[], key: string): boolean {
  const normalized = normalizeKey(key);
  if (DIRECT_SECRET_KEYS.has(normalized)) return true;
  if (normalized.includes('password') || normalized.includes('passwd')) return true;
  if (normalized.endsWith('token') || normalized.endsWith('secret')) return true;
  if (normalized.includes('apikey') || normalized.includes('privatekey')) return true;

  if (CONNECTION_KEYS.has(normalized)) {
    return path.some((part) => DATABASE_PARENTS.has(normalizeKey(part)));
  }
  return false;
}

function redactJsonValue(
  value: unknown,
  path: readonly string[],
  redactedFields: Set<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, path, redactedFields));
  }
  if (value === null || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const fieldPath = [...path, key];
    if (isSecretKey(path, key) && child !== null) {
      output[key] = REDACTED_VALUE;
      redactedFields.add(fieldPath.join('.'));
    } else {
      output[key] = redactJsonValue(child, fieldPath, redactedFields);
    }
  }
  return output;
}

function redactJson(text: string, redactedFields: Set<string>): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const redacted = redactJsonValue(parsed, [], redactedFields);
    return JSON.stringify(redacted, null, 2);
  } catch {
    return undefined;
  }
}

interface YamlFrame {
  indent: number;
  key: string;
}

function redactYaml(text: string, redactedFields: Set<string>): string {
  const stack: YamlFrame[] = [];
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = /^(\s*)([^#][^:]*?):(\s*)(.*)$/.exec(line);
      if (match === null) return redactAssignmentLine(line, [], redactedFields);
      const indent = match[1]?.length ?? 0;
      const key = (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
      const value = match[4] ?? '';

      while ((stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
      const path = stack.map((frame) => frame.key);
      if (value.trim().length === 0) {
        stack.push({ indent, key });
        return line;
      }
      if (!isSecretKey(path, key)) return line;

      redactedFields.add([...path, key].join('.'));
      return (match[1] ?? '') + (match[2] ?? key) + ':' + (match[3] ?? ' ') + REDACTED_VALUE;
    })
    .join('\n');
}

function redactProperties(text: string, redactedFields: Set<string>): string {
  return text
    .split(/\r?\n/)
    .map((line) => redactAssignmentLine(line, [], redactedFields))
    .join('\n');
}

function redactAssignmentLine(
  line: string,
  path: readonly string[],
  redactedFields: Set<string>,
): string {
  const match = /^(\s*)([A-Za-z0-9_.-]+)(\s*[:=]\s*)(.*)$/.exec(line);
  if (match === null) return line;
  const key = match[2] ?? '';
  if (!isSecretKey(path, key)) return line;
  redactedFields.add([...path, key].join('.'));
  return (match[1] ?? '') + key + (match[3] ?? '=') + REDACTED_VALUE;
}

function containsHighRiskSecret(text: string): boolean {
  return HIGH_RISK_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizeSanitizedText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export interface SanitizedText {
  ok: true;
  text: string;
  redactedFields: string[];
  redactionCount: number;
}

export interface SecretContentDenied {
  ok: false;
  reason: 'secret-content';
}

export type SanitizeResult = SanitizedText | SecretContentDenied;

/**
 * Remove credential-valued fields before text is returned or indexed.
 *
 * JSON, YAML and properties files receive structure-aware redaction. Other
 * text receives conservative assignment-line redaction. Opaque private-key
 * blocks and token literals that remain after field redaction deny the file.
 */
export function sanitizeModelVisibleText(text: string, filePath = ''): SanitizeResult {
  const redactedFields = new Set<string>();
  const extension = posixPath.extname(filePath).toLowerCase();

  let sanitized: string;
  if (extension === '.json') {
    sanitized = redactJson(text, redactedFields) ?? redactProperties(text, redactedFields);
  } else if (extension === '.yml' || extension === '.yaml') {
    sanitized = redactYaml(text, redactedFields);
  } else {
    sanitized = redactProperties(text, redactedFields);
  }

  if (containsHighRiskSecret(sanitized)) {
    return { ok: false, reason: 'secret-content' };
  }

  const normalized = normalizeSanitizedText(sanitized);
  return {
    ok: true,
    text: normalized,
    redactedFields: [...redactedFields].sort(),
    redactionCount: redactedFields.size,
  };
}

/** True only for opaque secret material that must deny the whole file. */
export function containsHighRiskSecretMaterial(text: string): boolean {
  return containsHighRiskSecret(text);
}
