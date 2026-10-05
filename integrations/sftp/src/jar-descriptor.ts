/**
 * Bounded parsers for plugin descriptors and safe build metadata.
 *
 * Parsing uses literal/string operations rather than dynamic regular
 * expressions because deployed JAR metadata is untrusted input.
 */

import {
  emptyPlugin,
  type JarBuildMetadata,
  type PluginDescriptorKind,
  type PluginMetadata,
} from './jar-types.js';

const MAX_METADATA_LINES = 8_192;
const MAX_METADATA_LINE_CHARS = 16_384;

interface YamlField {
  indent: number;
  key: string;
  value: string;
}

interface PaperDependency {
  name: string;
  optional: boolean;
}

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

function leadingWhitespace(line: string): number {
  let count = 0;
  while (count < line.length && (line[count] === ' ' || line[count] === '\t')) count += 1;
  return count;
}

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === last && (first === '"' || first === "'"))
    ? trimmed.slice(1, -1)
    : trimmed;
}

function yamlField(line: string): YamlField | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('- ')) {
    return undefined;
  }
  const separator = trimmed.indexOf(':');
  if (separator <= 0) return undefined;
  const key = cleanScalar(trimmed.slice(0, separator));
  if (key.length === 0) return undefined;
  return {
    indent: leadingWhitespace(line),
    key,
    value: trimmed.slice(separator + 1).trim(),
  };
}

function topLevelField(lines: readonly string[], key: string): { index: number; field: YamlField } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const field = yamlField(lines[index] ?? '');
    if (field?.indent === 0 && field.key === key) return { index, field };
  }
  return undefined;
}

function topLevelScalar(lines: readonly string[], key: string): string | undefined {
  const found = topLevelField(lines, key);
  if (found === undefined || found.field.value.length === 0) return undefined;
  const withoutComment = found.field.value.split(' #', 1)[0] ?? found.field.value;
  return cleanScalar(withoutComment);
}

function parseInlineList(value: string): string[] {
  const clean = value.trim();
  if (!clean.startsWith('[') || !clean.endsWith(']')) return [];
  return clean
    .slice(1, -1)
    .split(',')
    .map((item) => cleanScalar(item))
    .filter((item) => item.length > 0);
}

function indentedList(lines: readonly string[], start: number): string[] {
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    if (leadingWhitespace(line) === 0) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) values.push(cleanScalar(trimmed.slice(2)));
  }
  return values;
}

function topLevelList(lines: readonly string[], key: string): string[] {
  const found = topLevelField(lines, key);
  if (found === undefined) return [];
  const inline = parseInlineList(found.field.value);
  return inline.length > 0 ? inline : indentedList(lines, found.index);
}

function sectionKeys(lines: readonly string[], section: string): string[] {
  const found = topLevelField(lines, section);
  if (found === undefined || found.field.value.length > 0) return [];

  let childIndent: number | undefined;
  const result: string[] = [];
  for (let index = found.index + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const field = yamlField(line);
    if (field === undefined) continue;
    if (field.indent === 0) break;
    childIndent ??= field.indent;
    if (field.indent === childIndent) result.push(field.key);
  }
  return result;
}

function paperDependencies(lines: readonly string[]): PaperDependency[] {
  const found = topLevelField(lines, 'dependencies');
  if (found === undefined || found.field.value.length > 0) return [];

  const result: PaperDependency[] = [];
  let categoryIndent: number | undefined;
  let pluginIndent: number | undefined;
  let current: PaperDependency | undefined;

  for (let index = found.index + 1; index < lines.length; index += 1) {
    const field = yamlField(lines[index] ?? '');
    if (field === undefined) continue;
    if (field.indent === 0) break;
    categoryIndent ??= field.indent;

    if (field.indent === categoryIndent && (field.key === 'server' || field.key === 'bootstrap')) {
      current = undefined;
      continue;
    }
    if (field.indent <= categoryIndent) continue;
    pluginIndent ??= field.indent;
    if (field.indent === pluginIndent) {
      current = { name: field.key, optional: false };
      result.push(current);
      continue;
    }
    if (current !== undefined && field.key === 'required' && field.value.toLowerCase() === 'false') {
      current.optional = true;
    }
  }
  return result;
}

export function parseBukkitDescriptor(
  text: string,
  descriptor: Extract<PluginDescriptorKind, 'plugin.yml' | 'paper-plugin.yml'>,
): PluginMetadata {
  const lines = boundedLines(text);
  const name = topLevelScalar(lines, 'name');
  const version = topLevelScalar(lines, 'version');
  const mainClass = topLevelScalar(lines, 'main');
  if (name === undefined || version === undefined || mainClass === undefined) {
    return { ...emptyPlugin('MALFORMED'), descriptor, metadataError: 'invalid-descriptor' };
  }

  const paper = descriptor === 'paper-plugin.yml' ? paperDependencies(lines) : [];
  const required = paper.filter((dependency) => !dependency.optional).map((dependency) => dependency.name);
  const optional = paper.filter((dependency) => dependency.optional).map((dependency) => dependency.name);
  return {
    status: 'OK',
    descriptor,
    name,
    version,
    mainClass,
    dependencies: [...new Set([...topLevelList(lines, 'depend'), ...required])],
    softDependencies: [...new Set([...topLevelList(lines, 'softdepend'), ...optional])],
    loadBefore: topLevelList(lines, 'loadbefore'),
    commands: sectionKeys(lines, 'commands'),
    permissions: sectionKeys(lines, 'permissions'),
  };
}

function velocityDependencyLists(value: unknown): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  if (!Array.isArray(value)) return { required, optional };

  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const dependency = raw as Record<string, unknown>;
    if (typeof dependency.id !== 'string') continue;
    (dependency.optional === true ? optional : required).push(dependency.id);
  }
  return { required, optional };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function parseVelocityDescriptor(text: string): PluginMetadata {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ...emptyPlugin('MALFORMED'), descriptor: 'velocity-plugin.json', metadataError: 'invalid-descriptor' };
  }

  const name = typeof data.name === 'string' ? data.name : typeof data.id === 'string' ? data.id : undefined;
  const version = typeof data.version === 'string' ? data.version : undefined;
  const mainClass = typeof data.main === 'string' ? data.main : undefined;
  if (name === undefined || version === undefined || mainClass === undefined) {
    return { ...emptyPlugin('MALFORMED'), descriptor: 'velocity-plugin.json', metadataError: 'invalid-descriptor' };
  }

  const dependencies = velocityDependencyLists(data.dependencies);
  return {
    status: 'OK',
    descriptor: 'velocity-plugin.json',
    name,
    version,
    mainClass,
    dependencies: dependencies.required,
    softDependencies: dependencies.optional,
    loadBefore: stringArray(data.loadBefore),
    commands: [],
    permissions: [],
  };
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

function parseManifest(text: string): Map<string, string> {
  const unfolded = text.split(/\r?\n/).reduce<string[]>((lines, line) => {
    if (line.startsWith(' ') && lines.length > 0) {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? '') + line.slice(1);
    } else {
      lines.push(line);
    }
    return lines;
  }, []);
  return parsePropertyLines(unfolded.join('\n'), ':');
}

function parseProperties(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of boundedLines(text)) {
    const colon = propertyPair(line, ':');
    const equals = propertyPair(line, '=');
    const pair = chooseEarlierPair(line, colon, equals);
    if (pair !== undefined) values.set(pair[0], pair[1]);
  }
  return values;
}

function chooseEarlierPair(
  line: string,
  colon: [string, string] | undefined,
  equals: [string, string] | undefined,
): [string, string] | undefined {
  if (colon === undefined) return equals;
  if (equals === undefined) return colon;
  const colonIndex = line.indexOf(':');
  const equalsIndex = line.indexOf('=');
  return colonIndex < equalsIndex ? colon : equals;
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

function validGitSha(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length < 7 || value.length > 64) return undefined;
  for (const char of value) {
    const lower = char.toLowerCase();
    if (!(lower >= '0' && lower <= '9') && !(lower >= 'a' && lower <= 'f')) return undefined;
  }
  return value.toLowerCase();
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

export function parseBuildMetadata(entries: Map<string, string>): JarBuildMetadata {
  const maps = metadataMaps(entries);
  const build: JarBuildMetadata = {};
  const git = validGitSha(firstValue(maps, [
    'git-commit',
    'git-sha',
    'build-revision',
    'git.commit.id.full',
    'git.commit.id',
    'git.commit.id.abbrev',
  ]));
  const version = firstValue(maps, ['implementation-version', 'build-version', 'version']);
  const buildId = firstValue(maps, ['build-number', 'build-id']);
  const timestamp = firstValue(maps, ['build-time', 'build-timestamp', 'git.build.time']);
  if (git !== undefined) build.gitSourceSha = git;
  if (version !== undefined) build.buildVersion = version;
  if (buildId !== undefined) build.buildId = buildId;
  if (timestamp !== undefined) build.buildTimestamp = timestamp;
  return build;
}
