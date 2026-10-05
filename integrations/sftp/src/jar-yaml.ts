import {
  emptyPlugin,
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

interface PaperState {
  categoryIndent?: number;
  pluginIndent?: number;
  current?: PaperDependency;
  dependencies: PaperDependency[];
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
  while (count < line.length && (line[count] === ' ' || line[count] === '\t')) {
    count += 1;
  }
  return count;
}

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const quoted = first === last && (first === '"' || first === "'");
  return quoted ? trimmed.slice(1, -1) : trimmed;
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

function topLevelField(
  lines: readonly string[],
  key: string,
): { index: number; field: YamlField } | undefined {
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

function isPaperCategory(field: YamlField, indent: number): boolean {
  return field.indent === indent &&
    (field.key === 'server' || field.key === 'bootstrap');
}

function addPaperPlugin(field: YamlField, state: PaperState): void {
  const dependency = { name: field.key, optional: false };
  state.current = dependency;
  state.dependencies.push(dependency);
}

function applyPaperField(field: YamlField, state: PaperState): 'continue' | 'stop' {
  if (field.indent === 0) return 'stop';
  state.categoryIndent ??= field.indent;

  if (isPaperCategory(field, state.categoryIndent)) {
    state.current = undefined;
    return 'continue';
  }
  if (field.indent <= state.categoryIndent) return 'continue';

  state.pluginIndent ??= field.indent;
  if (field.indent === state.pluginIndent) {
    addPaperPlugin(field, state);
    return 'continue';
  }
  if (state.current !== undefined &&
      field.key === 'required' &&
      field.value.toLowerCase() === 'false') {
    state.current.optional = true;
  }
  return 'continue';
}

function paperDependencies(lines: readonly string[]): PaperDependency[] {
  const found = topLevelField(lines, 'dependencies');
  if (found === undefined || found.field.value.length > 0) return [];

  const state: PaperState = { dependencies: [] };
  for (let index = found.index + 1; index < lines.length; index += 1) {
    const field = yamlField(lines[index] ?? '');
    if (field === undefined) continue;
    if (applyPaperField(field, state) === 'stop') break;
  }
  return state.dependencies;
}

function dependencyNames(
  paper: readonly PaperDependency[],
  optional: boolean,
): string[] {
  return paper
    .filter((dependency) => dependency.optional === optional)
    .map((dependency) => dependency.name);
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
  return {
    status: 'OK',
    descriptor,
    name,
    version,
    mainClass,
    dependencies: [...new Set([
      ...topLevelList(lines, 'depend'),
      ...dependencyNames(paper, false),
    ])],
    softDependencies: [...new Set([
      ...topLevelList(lines, 'softdepend'),
      ...dependencyNames(paper, true),
    ])],
    loadBefore: topLevelList(lines, 'loadbefore'),
    commands: sectionKeys(lines, 'commands'),
    permissions: sectionKeys(lines, 'permissions'),
  };
}
