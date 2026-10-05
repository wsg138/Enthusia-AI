import type { JarBuildMetadata } from './jar-types.js';

const MAX_METADATA_LINES = 8_192;
const MAX_METADATA_LINE_CHARS = 16_384;
const GIT_SHA = /^[0-9a-f]{7,64}$/i;

function boundedLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_METADATA_LINES) throw new Error('metadata line limit exceeded');
  for (const line of lines) {
    if (line.length > MAX_METADATA_LINE_CHARS) {
      throw new Error('metadata line length exceeded');
    }
  }
  return lines;
}

function propertyPair(line: string, separator: string): [string, string] | undefined {
  const index = line.indexOf(separator);
  if (index <= 0) return undefined;
  const key = line.slice(0, index).trim().toLowerCase();
  if (key.length === 0 || key.startsWith('#') || key.startsWith('!')) return undefined;
  return [key, line.slice(index + separator.length).trim()];
}

function parsePropertyLines(text: string, separator: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of boundedLines(text)) {
    const pair = propertyPair(line, separator);
    if (pair !== undefined) values.set(pair[0], pair[1]);
  }
  return values;
}

function unfoldManifest(text: string): string {
  const output: string[] = [];
  for (const line of boundedLines(text)) {
    if (line.startsWith(' ') && output.length > 0) {
      output[output.length - 1] = (output[output.length - 1] ?? '') + line.slice(1);
    } else {
      output.push(line);
    }
  }
  return output.join('\n');
}

function parseManifest(text: string): Map<string, string> {
  return parsePropertyLines(unfoldManifest(text), ':');
}

function earlierPair(
  line: string,
  colon: [string, string] | undefined,
  equals: [string, string] | undefined,
): [string, string] | undefined {
  if (colon === undefined) return equals;
  if (equals === undefined) return colon;
  return line.indexOf(':') < line.indexOf('=') ? colon : equals;
}

function parseProperties(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of boundedLines(text)) {
    const pair = earlierPair(
      line,
      propertyPair(line, ':'),
      propertyPair(line, '='),
    );
    if (pair !== undefined) values.set(pair[0], pair[1]);
  }
  return values;
}

function firstValue(
  maps: readonly Map<string, string>[],
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    for (const map of maps) {
      const value = map.get(key);
      if (value !== undefined && value.length > 0) return value;
    }
  }
  return undefined;
}

function metadataMaps(entries: Map<string, string>): Map<string, string>[] {
  const maps = [parseManifest(entries.get('META-INF/MANIFEST.MF') ?? '')];
  for (const [name, text] of entries) {
    const lower = name.toLowerCase();
    if (lower.endsWith('git.properties') || lower.endsWith('pom.properties')) {
      maps.push(parseProperties(text));
    }
  }
  return maps;
}

function assignBuildField(
  target: JarBuildMetadata,
  key: keyof JarBuildMetadata,
  value: string | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

export function parseBuildMetadata(entries: Map<string, string>): JarBuildMetadata {
  const maps = metadataMaps(entries);
  const build: JarBuildMetadata = {};
  const rawGit = firstValue(maps, [
    'git-commit',
    'git-sha',
    'build-revision',
    'git.commit.id.full',
    'git.commit.id',
    'git.commit.id.abbrev',
  ]);
  const git = rawGit !== undefined && GIT_SHA.test(rawGit)
    ? rawGit.toLowerCase()
    : undefined;

  assignBuildField(build, 'gitSourceSha', git);
  assignBuildField(
    build,
    'buildVersion',
    firstValue(maps, ['implementation-version', 'build-version', 'version']),
  );
  assignBuildField(build, 'buildId', firstValue(maps, ['build-number', 'build-id']));
  assignBuildField(
    build,
    'buildTimestamp',
    firstValue(maps, ['build-time', 'build-timestamp', 'git.build.time']),
  );
  return build;
}
