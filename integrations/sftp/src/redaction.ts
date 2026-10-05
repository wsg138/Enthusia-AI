/**
 * Secret-aware sanitization for model-visible server text.
 *
 * Useful configuration may describe integrations, but authentication values
 * never leave this boundary. Structured secret fields are redacted and opaque
 * high-risk secret material denies the entire document.
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
  'webhook',
  'webhookurl',
  'webhooksecret',
  'forwardingsecret',
  'sharedsecret',
  'privatekey',
  'secretkey',
  'credential',
  'credentials',
  'sftpcredential',
  'sftpcredentials',
  'sftppassword',
  'databaseurl',
  'jdbcurl',
  'dsn',
  'connectionstring',
  'authorization',
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

const SECRET_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'apikey',
  'privatekey',
  'credential',
] as const;

const SECRET_KEY_SUFFIXES = ['token', 'secret'] as const;

const HIGH_RISK_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /-----BEGIN ENCRYPTED PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bmfa\.[A-Za-z0-9_-]{20,}\b/,
];

interface YamlFrame {
  indent: number;
  key: string;
}

interface YamlField {
  indent: number;
  prefix: string;
  rawKey: string;
  key: string;
  separator: string;
  value: string;
}

interface YamlState {
  stack: YamlFrame[];
  redactedBlockIndent: number | undefined;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isDatabaseParent(path: readonly string[]): boolean {
  return path.some((part) => DATABASE_PARENTS.has(normalizeKey(part)));
}

function containsSecretFragment(key: string): boolean {
  return SECRET_KEY_FRAGMENTS.some((fragment) => key.includes(fragment));
}

function hasSecretSuffix(key: string): boolean {
  return SECRET_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

function isSecretKey(path: readonly string[], key: string): boolean {
  const normalized = normalizeKey(key);
  if (DIRECT_SECRET_KEYS.has(normalized)) return true;
  if (containsSecretFragment(normalized)) return true;
  if (hasSecretSuffix(normalized)) return true;
  return CONNECTION_KEYS.has(normalized) && isDatabaseParent(path);
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
      continue;
    }
    output[key] = redactJsonValue(child, fieldPath, redactedFields);
  }
  return output;
}

function redactJson(text: string, redactedFields: Set<string>): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(redactJsonValue(parsed, [], redactedFields), null, 2);
  } catch {
    return undefined;
  }
}

function parseYamlField(line: string): YamlField | undefined {
  const match = /^(\s*)([^#][^:]*?):(\s*)(.*)$/.exec(line);
  if (match === null) return undefined;
  const rawKey = match[2] ?? '';
  return {
    indent: (match[1] ?? '').length,
    prefix: match[1] ?? '',
    rawKey,
    key: rawKey.trim().replace(/^['"]|['"]$/g, ''),
    separator: match[3] ?? ' ',
    value: match[4] ?? '',
  };
}

function trimYamlStack(state: YamlState, indent: number): void {
  while ((state.stack.at(-1)?.indent ?? -1) >= indent) state.stack.pop();
}

function insideRedactedYamlBlock(state: YamlState, indent: number): boolean {
  const blockIndent = state.redactedBlockIndent;
  if (blockIndent === undefined) return false;
  if (indent > blockIndent) return true;
  state.redactedBlockIndent = undefined;
  return false;
}

function redactYamlField(
  field: YamlField,
  state: YamlState,
  redactedFields: Set<string>,
): string {
  trimYamlStack(state, field.indent);
  const path = state.stack.map((frame) => frame.key);
  if (!isSecretKey(path, field.key)) {
    if (field.value.trim().length === 0) {
      state.stack.push({ indent: field.indent, key: field.key });
    }
    return field.prefix + field.rawKey + ':' + field.separator + field.value;
  }

  redactedFields.add([...path, field.key].join('.'));
  if (field.value.trim().length === 0) state.redactedBlockIndent = field.indent;
  const separator = field.separator.length === 0 ? ' ' : field.separator;
  return field.prefix + field.rawKey + ':' + separator + REDACTED_VALUE;
}

function redactYamlLine(
  line: string,
  state: YamlState,
  redactedFields: Set<string>,
): string | undefined {
  const indent = line.length - line.trimStart().length;
  if (insideRedactedYamlBlock(state, indent)) return undefined;

  const field = parseYamlField(line);
  if (field === undefined) return redactAssignmentLine(line, [], redactedFields);
  return redactYamlField(field, state, redactedFields);
}

function redactYaml(text: string, redactedFields: Set<string>): string {
  const state: YamlState = { stack: [], redactedBlockIndent: undefined };
  const output: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const redacted = redactYamlLine(line, state, redactedFields);
    if (redacted !== undefined) output.push(redacted);
  }
  return output.join('\n');
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

function redactByFormat(
  text: string,
  extension: string,
  redactedFields: Set<string>,
): string {
  if (extension === '.json') {
    return redactJson(text, redactedFields) ?? redactProperties(text, redactedFields);
  }
  if (extension === '.yml' || extension === '.yaml') {
    return redactYaml(text, redactedFields);
  }
  return redactProperties(text, redactedFields);
}

/**
 * Remove credential-valued fields before text is returned or indexed.
 */
export function sanitizeModelVisibleText(text: string, filePath = ''): SanitizeResult {
  const redactedFields = new Set<string>();
  const extension = posixPath.extname(filePath).toLowerCase();
  const sanitized = redactByFormat(text, extension, redactedFields);

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

export function containsHighRiskSecretMaterial(text: string): boolean {
  return containsHighRiskSecret(text);
}
