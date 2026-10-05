import type { DeploymentIdentity } from './live-types.js';

const REDACTED = '[REDACTED]';

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function jsonValues(text: string): Map<string, string> | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const values = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' || typeof value === 'number') {
        values.set(normalizeKey(key), String(value));
      }
    }
    return values;
  } catch {
    return undefined;
  }
}

function lineValue(line: string): [string, string] | undefined {
  const equals = line.indexOf('=');
  const colon = line.indexOf(':');
  const indexes = [equals, colon].filter((index) => index > 0);
  if (indexes.length === 0) return undefined;

  const separator = Math.min(...indexes);
  const key = normalizeKey(line.slice(0, separator).trim());
  if (key.length === 0) return undefined;
  return [key, line.slice(separator + 1).trim()];
}

function propertyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const pair = lineValue(line);
    if (pair !== undefined) values.set(pair[0], pair[1]);
  }
  return values;
}

function firstValue(
  values: ReadonlyMap<string, string>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = values.get(key);
    if (value !== undefined && value.length > 0 && value !== REDACTED) return value;
  }
  return undefined;
}

function validGitSha(value: string | undefined): string | undefined {
  return value !== undefined && /^[0-9a-f]{7,64}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function assignIfPresent(
  target: DeploymentIdentity,
  key: keyof DeploymentIdentity,
  value: string | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

export function parseDeploymentIdentity(text: string): DeploymentIdentity {
  const values = jsonValues(text) ?? propertyValues(text);
  const result: DeploymentIdentity = {};

  assignIfPresent(result, 'deploymentId', firstValue(values, ['deploymentid', 'releaseid']));
  assignIfPresent(
    result,
    'runtimeVersion',
    firstValue(values, ['runtimeversion', 'version', 'releaseversion']),
  );
  assignIfPresent(
    result,
    'gitSha',
    validGitSha(firstValue(values, ['gitsha', 'gitcommit', 'commitsha', 'revision'])),
  );
  assignIfPresent(result, 'buildId', firstValue(values, ['buildid', 'buildnumber']));
  assignIfPresent(
    result,
    'deployedAt',
    firstValue(values, ['deployedat', 'deploymenttime', 'releasedat']),
  );
  return result;
}
