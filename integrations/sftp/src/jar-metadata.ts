/**
 * Safe plugin JAR metadata extraction.
 *
 * JARs are ZIP files. This parser reads only a small descriptor allowlist and
 * never loads classes or executes plugin code.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;

const EXACT_METADATA_ENTRIES = new Set([
  'plugin.yml',
  'paper-plugin.yml',
  'velocity-plugin.json',
  'META-INF/MANIFEST.MF',
  'git.properties',
  'META-INF/git.properties',
]);

export type PluginDescriptorKind =
  | 'plugin.yml'
  | 'paper-plugin.yml'
  | 'velocity-plugin.json';

export interface PluginMetadata {
  status: 'OK' | 'MISSING' | 'MALFORMED';
  descriptor?: PluginDescriptorKind;
  name?: string;
  version?: string;
  mainClass?: string;
  dependencies: string[];
  softDependencies: string[];
  loadBefore: string[];
  commands: string[];
  permissions: string[];
  metadataError?: 'invalid-archive' | 'invalid-descriptor';
}

export interface JarBuildMetadata {
  gitSourceSha?: string;
  buildVersion?: string;
  buildId?: string;
  buildTimestamp?: string;
}

export interface ParsedPluginJar {
  plugin: PluginMetadata;
  build: JarBuildMetadata;
  inspectedEntries: string[];
}

interface ZipEntry {
  name: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface ZipDirectory {
  entries: ZipEntry[];
}

interface PaperDependency {
  name: string;
  optional: boolean;
}

function emptyPlugin(status: PluginMetadata['status']): PluginMetadata {
  return {
    status,
    dependencies: [],
    softDependencies: [],
    loadBefore: [],
    commands: [],
    permissions: [],
  };
}

function assertRange(buffer: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error('invalid archive bounds');
  }
}

function findEocd(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('missing end-of-central-directory');
}

function parseCentralEntry(buffer: Buffer, offset: number): { entry: ZipEntry; next: number } {
  assertRange(buffer, offset, 46);
  if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
    throw new Error('invalid central-directory signature');
  }
  const nameLength = buffer.readUInt16LE(offset + 28);
  const extraLength = buffer.readUInt16LE(offset + 30);
  const commentLength = buffer.readUInt16LE(offset + 32);
  const fullLength = 46 + nameLength + extraLength + commentLength;
  assertRange(buffer, offset, fullLength);

  const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
  return {
    entry: {
      name,
      flags: buffer.readUInt16LE(offset + 8),
      compressionMethod: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    },
    next: offset + fullLength,
  };
}

function parseZipDirectory(buffer: Buffer): ZipDirectory {
  const eocd = findEocd(buffer);
  assertRange(buffer, eocd, 22);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('zip64 metadata is not supported');
  }
  assertRange(buffer, centralOffset, centralSize);

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    const parsed = parseCentralEntry(buffer, cursor);
    entries.push(parsed.entry);
    cursor = parsed.next;
  }
  if (cursor > centralOffset + centralSize) throw new Error('central directory overflow');
  return { entries };
}

function readZipEntry(buffer: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if ((entry.flags & 0x1) !== 0) throw new Error('encrypted zip entry');
  if (entry.uncompressedSize > maxBytes) throw new Error('metadata entry too large');

  const offset = entry.localHeaderOffset;
  assertRange(buffer, offset, 30);
  if (buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) throw new Error('invalid local header');
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  assertRange(buffer, dataOffset, entry.compressedSize);
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod !== 8) throw new Error('unsupported zip compression');
  const output = inflateRawSync(compressed, { maxOutputLength: maxBytes });
  if (output.length > maxBytes) throw new Error('metadata entry too large');
  return output;
}

function isAllowedMetadataEntry(name: string): boolean {
  if (EXACT_METADATA_ENTRIES.has(name)) return true;
  const lower = name.toLowerCase();
  return lower.endsWith('/git.properties') || lower.endsWith('/pom.properties');
}

function extractMetadataEntries(
  jar: Buffer,
  maxEntryBytes: number,
): Map<string, string> {
  const directory = parseZipDirectory(jar);
  const result = new Map<string, string>();
  let totalBytes = 0;

  for (const entry of directory.entries) {
    if (!isAllowedMetadataEntry(entry.name) || result.has(entry.name)) continue;
    const bytes = readZipEntry(jar, entry, maxEntryBytes);
    totalBytes += bytes.length;
    if (totalBytes > maxEntryBytes * 8) throw new Error('metadata budget exceeded');
    result.set(entry.name, bytes.toString('utf8'));
  }
  return result;
}

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

function topLevelScalar(text: string, key: string): string | undefined {
  const pattern = new RegExp('^' + escapeRegex(key) + '\\s*:\\s*(.+)$', 'im');
  const match = pattern.exec(text);
  return match?.[1] === undefined ? undefined : cleanScalar(match[1].replace(/\s+#.*$/, ''));
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

function topLevelList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const prefix = new RegExp('^' + escapeRegex(key) + '\\s*:');
  const start = lines.findIndex((line) => prefix.test(line));
  if (start < 0) return [];

  const initial = lines[start]?.replace(new RegExp('^' + escapeRegex(key) + '\\s*:\\s*'), '') ?? '';
  const inline = parseInlineList(initial);
  if (inline.length > 0) return inline;

  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\S/.test(line) && line.trim().length > 0) break;
    const match = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) values.push(cleanScalar(match[1]));
  }
  return values;
}

function sectionKeys(text: string, section: string): string[] {
  const lines = text.split(/\r?\n/);
  const prefix = new RegExp('^' + escapeRegex(section) + '\\s*:\\s*$');
  const start = lines.findIndex((line) => prefix.test(line));
  if (start < 0) return [];

  let childIndent: number | undefined;
  const result: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const match = /^(\s+)([^:#][^:]*):/.exec(line);
    if (match === null) {
      if (/^\S/.test(line)) break;
      continue;
    }
    const indent = match[1]?.length ?? 0;
    if (childIndent === undefined) childIndent = indent;
    if (indent < childIndent) break;
    if (indent === childIndent) result.push(cleanScalar((match[2] ?? '').trim()));
  }
  return result;
}

function paperDependencies(text: string): PaperDependency[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^dependencies\s*:\s*$/.test(line));
  if (start < 0) return [];

  const result: PaperDependency[] = [];
  let pluginIndent: number | undefined;
  let current: PaperDependency | undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\S/.test(line) && line.trim().length > 0) break;
    const keyMatch = /^(\s+)([^:#][^:]*):\s*(.*)$/.exec(line);
    if (keyMatch === null) continue;
    const indent = keyMatch[1]?.length ?? 0;
    const key = cleanScalar((keyMatch[2] ?? '').trim());
    const value = (keyMatch[3] ?? '').trim();

    if (pluginIndent === undefined && (key === 'server' || key === 'bootstrap')) continue;
    if (pluginIndent === undefined) pluginIndent = indent;
    if (indent === pluginIndent) {
      current = { name: key, optional: false };
      result.push(current);
    } else if (current !== undefined && key === 'required' && value.toLowerCase() === 'false') {
      current.optional = true;
    }
  }
  return result;
}

function parseBukkitDescriptor(text: string, descriptor: 'plugin.yml' | 'paper-plugin.yml'): PluginMetadata {
  const name = topLevelScalar(text, 'name');
  const version = topLevelScalar(text, 'version');
  const mainClass = topLevelScalar(text, 'main');
  if (name === undefined || version === undefined || mainClass === undefined) {
    return { ...emptyPlugin('MALFORMED'), descriptor, metadataError: 'invalid-descriptor' };
  }

  const paper = descriptor === 'paper-plugin.yml' ? paperDependencies(text) : [];
  return {
    status: 'OK',
    descriptor,
    name,
    version,
    mainClass,
    dependencies: [...new Set([...topLevelList(text, 'depend'), ...paper.filter((d) => !d.optional).map((d) => d.name)])],
    softDependencies: [...new Set([...topLevelList(text, 'softdepend'), ...paper.filter((d) => d.optional).map((d) => d.name)])],
    loadBefore: topLevelList(text, 'loadbefore'),
    commands: sectionKeys(text, 'commands'),
    permissions: sectionKeys(text, 'permissions'),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function parseVelocityDescriptor(text: string): PluginMetadata {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const name = typeof data.name === 'string' ? data.name : typeof data.id === 'string' ? data.id : undefined;
    const version = typeof data.version === 'string' ? data.version : undefined;
    const mainClass = typeof data.main === 'string' ? data.main : undefined;
    if (name === undefined || version === undefined || mainClass === undefined) {
      return { ...emptyPlugin('MALFORMED'), descriptor: 'velocity-plugin.json', metadataError: 'invalid-descriptor' };
    }

    const dependencies: string[] = [];
    const softDependencies: string[] = [];
    if (Array.isArray(data.dependencies)) {
      for (const raw of data.dependencies) {
        if (typeof raw !== 'object' || raw === null) continue;
        const dep = raw as Record<string, unknown>;
        if (typeof dep.id !== 'string') continue;
        if (dep.optional === true) softDependencies.push(dep.id);
        else dependencies.push(dep.id);
      }
    }
    return {
      status: 'OK',
      descriptor: 'velocity-plugin.json',
      name,
      version,
      mainClass,
      dependencies,
      softDependencies,
      loadBefore: stringArray(data.loadBefore),
      commands: [],
      permissions: [],
    };
  } catch {
    return { ...emptyPlugin('MALFORMED'), descriptor: 'velocity-plugin.json', metadataError: 'invalid-descriptor' };
  }
}

function parseManifest(text: string): Map<string, string> {
  const unfolded = text.replace(/\r?\n ([^\r\n]*)/g, '$1');
  const values = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return values;
}

function parseProperties(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^#!][^:=]*?)\s*[:=]\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined) values.set(match[1].trim().toLowerCase(), match[2] ?? '');
  }
  return values;
}

function firstValue(maps: readonly Map<string, string>[], keys: readonly string[]): string | undefined {
  for (const key of keys) {
    for (const map of maps) {
      const value = map.get(key.toLowerCase());
      if (value !== undefined && value.length > 0) return value;
    }
  }
  return undefined;
}

function validGitSha(value: string | undefined): string | undefined {
  return value !== undefined && /^[0-9a-f]{7,64}$/i.test(value) ? value.toLowerCase() : undefined;
}

function buildMetadata(entries: Map<string, string>): JarBuildMetadata {
  const manifest = parseManifest(entries.get('META-INF/MANIFEST.MF') ?? '');
  const propertyMaps = [...entries.entries()]
    .filter(([name]) => name.toLowerCase().endsWith('git.properties') || name.toLowerCase().endsWith('pom.properties'))
    .map(([, text]) => parseProperties(text));
  const maps = [manifest, ...propertyMaps];

  const build: JarBuildMetadata = {};
  const git = validGitSha(firstValue(maps, [
    'git-commit',
    'git-sha',
    'build-revision',
    'git.commit.id.full',
    'git.commit.id',
    'git.commit.id.abbrev',
  ]));
  const buildVersion = firstValue(maps, ['implementation-version', 'build-version', 'version']);
  const buildId = firstValue(maps, ['build-number', 'build-id']);
  const buildTimestamp = firstValue(maps, ['build-time', 'build-timestamp', 'git.build.time']);
  if (git !== undefined) build.gitSourceSha = git;
  if (buildVersion !== undefined) build.buildVersion = buildVersion;
  if (buildId !== undefined) build.buildId = buildId;
  if (buildTimestamp !== undefined) build.buildTimestamp = buildTimestamp;
  return build;
}

function pluginMetadata(entries: Map<string, string>): PluginMetadata {
  const plugin = entries.get('plugin.yml');
  if (plugin !== undefined) return parseBukkitDescriptor(plugin, 'plugin.yml');
  const paper = entries.get('paper-plugin.yml');
  if (paper !== undefined) return parseBukkitDescriptor(paper, 'paper-plugin.yml');
  const velocity = entries.get('velocity-plugin.json');
  if (velocity !== undefined) return parseVelocityDescriptor(velocity);
  return emptyPlugin('MISSING');
}

/**
 * Inspect a deployed JAR without executing it. Archive failures are returned
 * as metadata state so the deployed file identity can still be reported.
 */
export function parsePluginJar(jar: Buffer, maxMetadataBytes = 512 * 1024): ParsedPluginJar {
  try {
    const entries = extractMetadataEntries(jar, maxMetadataBytes);
    return {
      plugin: pluginMetadata(entries),
      build: buildMetadata(entries),
      inspectedEntries: [...entries.keys()].sort(),
    };
  } catch {
    return {
      plugin: { ...emptyPlugin('MALFORMED'), metadataError: 'invalid-archive' },
      build: {},
      inspectedEntries: [],
    };
  }
}
