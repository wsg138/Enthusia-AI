/**
 * @enthusia/integration-github — source file parsing (W08).
 *
 * Turns raw repository files into indexable text plus derived structure:
 *
 * - docs (README, markdown): raw text;
 * - plugin manifests (plugin.yml and equivalents): parsed commands and
 *   permissions, rendered as an indexable summary;
 * - code (Java/TypeScript/Python/...): raw text plus regex-extracted
 *   symbols (class/function names), which are prepended as a searchable
 *   header so exact symbol lookup works without embeddings;
 * - configs: raw text.
 *
 * Safety: binary files are skipped, oversized files are skipped, and any
 * file that looks like it contains secret material is skipped BEFORE
 * indexing (SECRET_DENY content must never enter the knowledge store —
 * spec §17.6). Manifest parsing uses a deliberate YAML *subset* parser,
 * not a general YAML engine, so exotic YAML features cannot surprise us.
 *
 * Spec: MASTER-SPECIFICATION.md §§12, 23, 33; WORKER-EXECUTION-PLAN.md §11.
 */

/** How a repository path should be treated by the indexer. */
export type FileKind = 'doc' | 'manifest' | 'code' | 'config' | 'skip';

/** Why a file was not indexed. */
export type SkipReason =
  | 'binary'
  | 'too-large'
  | 'secret-suspect'
  | 'excluded-path'
  | 'unsupported-kind';

export interface SkipDecision {
  skipped: true;
  reason: SkipReason;
  detail: string;
}

export interface ParsedFile {
  skipped: false;
  kind: Exclude<FileKind, 'skip'>;
  /** Indexable text for the file (may include a derived header/summary). */
  text: string;
  /** Code symbols extracted by regex (empty for non-code). */
  symbols: CodeSymbol[];
  /** Parsed plugin manifest, when kind === 'manifest'. */
  manifest?: PluginManifest;
  /** Content type label for artifact metadata. */
  contentType: string;
}

export type ParseResult = ParsedFile | SkipDecision;

export function isSkipped(result: ParseResult): result is SkipDecision {
  return result.skipped === true;
}

/** A class/function/interface/enum symbol found by regex. */
export interface CodeSymbol {
  kind: 'class' | 'interface' | 'enum' | 'function' | 'method' | 'type';
  name: string;
}

/** A single plugin command from a manifest. */
export interface PluginCommand {
  name: string;
  description?: string;
  permission?: string;
  usage?: string;
}

/** A single permission node from a manifest. */
export interface PluginPermission {
  node: string;
  description?: string;
  default?: string;
}

/** Parsed plugin manifest (plugin.yml and equivalents). */
export interface PluginManifest {
  /** Manifest format detected: 'bukkit' (plugin.yml), 'paper', 'velocity', ... */
  format: string;
  name: string;
  version: string;
  main?: string;
  description?: string;
  commands: PluginCommand[];
  permissions: PluginPermission[];
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  '.git',
  '.github', // workflow YAML is ops noise; reconsider if CI knowledge is wanted
  'node_modules',
  'target',
  'build',
  'dist',
  'out',
  '.gradle',
  '.idea',
  '.vscode',
  '__pycache__',
  'vendor',
]);

const BINARY_EXTENSIONS = new Set([
  '.jar',
  '.class',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.mp3',
  '.ogg',
  '.wav',
  '.mp4',
  '.mov',
  '.pdf',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.db',
  '.sqlite',
  '.dat',
  '.nbt',
  '.mca',
]);

/** Manifest basenames, mapped to their format label. */
const MANIFEST_FILES: Record<string, string> = {
  'plugin.yml': 'bukkit',
  'paper-plugin.yml': 'paper',
  'bungeecord.yml': 'bungeecord',
  'velocity-plugin.json': 'velocity',
  'plugin.json': 'generic-json',
};

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc']);
const CODE_EXTENSIONS = new Set([
  '.java',
  '.kt',
  '.kts',
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.lua',
  '.sql',
  '.sh',
]);
const CONFIG_EXTENSIONS = new Set(['.yml', '.yaml', '.json', '.properties', '.toml', '.cfg', '.conf', '.ini']);

/** Filenames that are never indexed (lockfiles, env files, key material). */
const NEVER_INDEX_BASENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'cargo.lock',
  'poetry.lock',
  '.env',
  '.env.local',
  '.env.production',
  'id_rsa',
  'id_ed25519',
  '.npmrc',
]);

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function extension(path: string): string {
  const base = basename(path).toLowerCase();
  const i = base.lastIndexOf('.');
  return i < 0 ? '' : base.slice(i);
}

/**
 * Decide how a repository path should be treated. Pure function of the
 * path — content-based skips (binary/secret/too-large) happen later in
 * `parseFile`.
 */
export function classifyPath(path: string): FileKind {
  const base = basename(path);
  const lowerBase = base.toLowerCase();

  if (NEVER_INDEX_BASENAMES.has(lowerBase)) return 'skip';
  if (lowerBase.startsWith('.env.')) return 'skip';

  const segments = path.split('/');
  for (const segment of segments.slice(0, -1)) {
    if (SKIP_DIRS.has(segment)) return 'skip';
  }

  const manifestFormat = MANIFEST_FILES[lowerBase];
  if (manifestFormat !== undefined) return 'manifest';

  const ext = extension(path);
  if (BINARY_EXTENSIONS.has(ext)) return 'skip';
  if (DOC_EXTENSIONS.has(ext)) return 'doc';
  if (
    lowerBase === 'readme' ||
    lowerBase.startsWith('readme.') ||
    lowerBase === 'changelog' ||
    lowerBase.startsWith('changelog.')
  ) {
    return 'doc';
  }
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (CONFIG_EXTENSIONS.has(ext)) return 'config';
  return 'skip';
}

// ---------------------------------------------------------------------------
// Secret / binary pre-scan
// ---------------------------------------------------------------------------

/** Patterns that mark a file as secret-suspect. Kept conservative. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgho_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-(?:live|test)-[A-Za-z0-9]{10,}/,
  // Quoted assignment of a suspicious key: password = "...", api_key: '...'
  /\b(password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*['"][^'"]{8,}['"]/i,
];

function headSample(text: string): string {
  return text.slice(0, 32 * 1024);
}

/** True when the text contains NUL bytes or a secret pattern. */
export function looksLikeSecret(text: string): boolean {
  const sample = headSample(text);
  return SECRET_PATTERNS.some((re) => re.test(sample));
}

export function looksBinary(text: string): boolean {
  return headSample(text).includes('\u0000');
}

// ---------------------------------------------------------------------------
// Code symbol extraction (regex-based, MVP per WORKER-EXECUTION-PLAN §11)
// ---------------------------------------------------------------------------

export type SymbolLanguage = 'java' | 'typescript' | 'python' | 'unknown';

export function languageForPath(path: string): SymbolLanguage {
  const ext = extension(path);
  if (ext === '.java' || ext === '.kt' || ext === '.kts') return 'java';
  if (ext === '.ts' || ext === '.mts' || ext === '.cts' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return 'typescript';
  }
  if (ext === '.py') return 'python';
  return 'unknown';
}

const JAVA_TYPE_RE = /\b(?:class|interface|enum|record)\s+([A-Za-z_][\w$]*)/g;
/** Method/constructor definitions with a body: `... name(...) {`. */
const JAVA_METHOD_RE =
  /^[ \t]*(?:(?:public|protected|private|static|final|synchronized|abstract|native|default|transient|volatile)\s+)+[\w<>\[\].,\s?@]+\s+([a-zA-Z_][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[\w.,\s]+)?\s*\{/gm;

const TS_TYPE_RE = /\b(?:class|interface|enum|type)\s+([A-Za-z_]\w*)/g;
const TS_FUNCTION_RE = /\bfunction\s+([A-Za-z_]\w*)\s*\(/g;
const TS_CONST_FN_RE = /\b(?:export\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(/g;

const PY_CLASS_RE = /^class\s+([A-Za-z_]\w*)\s*(?:\(|:)/gm;
const PY_DEF_RE = /^def\s+([A-Za-z_]\w*)\s*\(/gm;

function uniqueSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((s) => {
    const key = `${s.kind}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract class/function names with language-specific regexes.
 * Deliberately simple (MVP): misses exotic declarations, never executes code.
 */
export function extractSymbols(language: SymbolLanguage, text: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const collect = (re: RegExp, kind: CodeSymbol['kind']): void => {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const name = match[1];
      if (name !== undefined) symbols.push({ kind, name });
    }
  };
  switch (language) {
    case 'java':
      collect(JAVA_TYPE_RE, 'class');
      collect(JAVA_METHOD_RE, 'method');
      break;
    case 'typescript':
      collect(TS_TYPE_RE, 'class');
      collect(TS_FUNCTION_RE, 'function');
      collect(TS_CONST_FN_RE, 'function');
      break;
    case 'python':
      collect(PY_CLASS_RE, 'class');
      collect(PY_DEF_RE, 'function');
      break;
    case 'unknown':
      break;
  }
  return uniqueSymbols(symbols).slice(0, 500);
}

// ---------------------------------------------------------------------------
// Minimal YAML-subset parser (plugin manifests)
// ---------------------------------------------------------------------------

type YamlValue = string | number | boolean | null | YamlObject | YamlValue[];
interface YamlObject {
  [key: string]: YamlValue;
}

function parseScalar(raw: string): YamlValue {
  const value = raw.trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
  const quoted = /^(['"])(.*)\1$/.exec(value);
  if (quoted !== null) return quoted[2] ?? '';
  return value;
}

function stripInlineComment(line: string): string {
  // Only strip comments outside quotes — good enough for manifests.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && i > 0 && line[i - 1] === ' ') {
      return line.slice(0, i);
    }
  }
  return line;
}

function indentOf(line: string): number {
  const match = /^\s*/.exec(line);
  return match === null ? 0 : match[0].length;
}

/**
 * Parse the indentation-based YAML subset used by plugin manifests:
 * nested maps, scalars, and `- item` lists. Anything fancier (anchors,
 * multi-line scalars, flow collections) is ignored rather than
 * mis-parsed — the manifest summary simply omits it.
 */
export function parseSimpleYaml(text: string): YamlObject {
  const root: YamlObject = {};
  const stack: Array<{ indent: number; container: YamlObject | YamlValue[] }> = [
    { indent: -1, container: root },
  ];

  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine).replace(/\s+$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = indentOf(line);
    const trimmed = line.trim();

    while (stack.length > 1 && indent <= (stack[stack.length - 1]?.indent ?? -1)) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]?.container;
    if (parent === undefined) continue;

    if (trimmed.startsWith('- ')) {
      const item = parseScalar(trimmed.slice(2));
      if (Array.isArray(parent)) {
        parent.push(item);
      }
      continue;
    }

    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();

    const target: YamlObject = Array.isArray(parent) ? {} : (parent as YamlObject);
    if (Array.isArray(parent)) {
      // `- key: value` list-of-maps is out of subset scope; skip.
      continue;
    }
    if (rest === '') {
      // Nested block — decide map vs list by peeking at the next line.
      const child: YamlObject | YamlValue[] = [];
      target[key] = child;
      stack.push({ indent, container: child });
    } else {
      target[key] = parseScalar(rest);
    }
  }
  return root;
}

/** A nested block that turned out to be a map is materialized on demand. */
function asMap(value: YamlValue | undefined): YamlObject | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as YamlObject;
}

function asString(value: YamlValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Parse a Bukkit-style plugin.yml into a PluginManifest. */
function parseBukkitManifest(text: string): PluginManifest {
  const doc = parseSimpleYaml(text);
  const commands: PluginCommand[] = [];
  const permissions: PluginPermission[] = [];

  // NOTE: parseSimpleYaml materializes nested blocks as arrays; a block
  // that contains only `key: value` lines is a map in disguise. Convert
  // lazily: re-scan the raw text for the section we care about.
  const section = (name: string): YamlObject => extractSection(text, name);

  for (const [name, raw] of Object.entries(section('commands'))) {
    const entry = asMap(raw) ?? {};
    const cmd: PluginCommand = { name };
    const description = asString(entry['description']);
    const permission = asString(entry['permission']);
    const usage = asString(entry['usage']);
    if (description !== undefined) cmd.description = description;
    if (permission !== undefined) cmd.permission = permission;
    if (usage !== undefined) cmd.usage = usage;
    commands.push(cmd);
  }
  for (const [node, raw] of Object.entries(section('permissions'))) {
    const entry = asMap(raw) ?? {};
    const perm: PluginPermission = { node };
    const description = asString(entry['description']);
    const def = asString(entry['default']);
    if (description !== undefined) perm.description = description;
    if (def !== undefined) perm.default = def;
    permissions.push(perm);
  }

  const manifest: PluginManifest = {
    format: 'bukkit',
    name: asString(doc['name']) ?? 'unknown',
    version: asString(doc['version']) ?? 'unknown',
    commands,
    permissions,
  };
  const main = asString(doc['main']);
  const description = asString(doc['description']);
  if (main !== undefined) manifest.main = main;
  if (description !== undefined) manifest.description = description;
  return manifest;
}

/**
 * Re-parse one top-level section with a tiny line scanner that correctly
 * builds maps. Used because the generic subset parser materializes
 * nested blocks as arrays.
 */
function extractSection(text: string, sectionName: string): YamlObject {
  const result: YamlObject = {};
  const lines = text.split('\n');
  let inSection = false;
  let sectionIndent = 0;
  let currentKey: string | undefined;
  let currentEntry: YamlObject | undefined;

  const flush = (): void => {
    if (currentKey !== undefined && currentEntry !== undefined) {
      result[currentKey] = currentEntry;
    }
    currentKey = undefined;
    currentEntry = undefined;
  };

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine).replace(/\s+$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = indentOf(line);
    const trimmed = line.trim();

    if (!inSection) {
      if (indent === 0 && trimmed === `${sectionName}:`) {
        inSection = true;
        sectionIndent = 0;
      }
      continue;
    }
    if (indent === 0) {
      flush();
      inSection = trimmed === `${sectionName}:`;
      continue;
    }
    if (trimmed.startsWith('- ')) continue; // lists out of scope here
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    if (indent === sectionIndent + 2 && rest === '') {
      flush();
      currentKey = key;
      currentEntry = {};
    } else if (currentEntry !== undefined && indent > sectionIndent + 2 && rest !== '') {
      currentEntry[key] = parseScalar(rest);
    }
  }
  flush();
  return result;
}

/** Parse a velocity-plugin.json manifest. */
function parseVelocityManifest(text: string): PluginManifest {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    doc = {};
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const manifest: PluginManifest = {
    format: 'velocity',
    name: str(doc['name']) ?? 'unknown',
    version: str(doc['version']) ?? 'unknown',
    commands: [],
    permissions: [],
  };
  const description = str(doc['description']);
  const main = str(doc['main']);
  if (description !== undefined) manifest.description = description;
  if (main !== undefined) manifest.main = main;
  return manifest;
}

export function parseManifest(format: string, text: string): PluginManifest {
  if (format === 'velocity' || format === 'generic-json') {
    return parseVelocityManifest(text);
  }
  return parseBukkitManifest(text);
}

/**
 * Render a manifest as indexable text: a human/lexical summary followed
 * by the raw manifest, so exact config keys and command names are
 * searchable (§39: vector similarity alone is insufficient for these).
 */
export function renderManifestText(manifest: PluginManifest, repoId: string, path: string): string {
  const lines: string[] = [
    `# plugin manifest: ${path} (${repoId})`,
    `plugin: ${manifest.name} version ${manifest.version}`,
  ];
  if (manifest.main !== undefined) lines.push(`main: ${manifest.main}`);
  if (manifest.description !== undefined) lines.push(`description: ${manifest.description}`);
  if (manifest.commands.length > 0) {
    lines.push('commands:');
    for (const cmd of manifest.commands) {
      const parts = [`  /${cmd.name}`];
      if (cmd.description !== undefined) parts.push(`- ${cmd.description}`);
      if (cmd.permission !== undefined) parts.push(`(permission: ${cmd.permission})`);
      if (cmd.usage !== undefined) parts.push(`(usage: ${cmd.usage})`);
      lines.push(parts.join(' '));
    }
  }
  if (manifest.permissions.length > 0) {
    lines.push('permissions:');
    for (const perm of manifest.permissions) {
      const parts = [`  ${perm.node}`];
      if (perm.description !== undefined) parts.push(`- ${perm.description}`);
      if (perm.default !== undefined) parts.push(`(default: ${perm.default})`);
      lines.push(parts.join(' '));
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Top-level file parsing
// ---------------------------------------------------------------------------

export interface ParseOptions {
  maxBytes: number;
  /** `owner/repo`, used in manifest summary headers. */
  repoId: string;
}

/**
 * Parse one repository file into indexable text.
 * Order of checks: size -> binary -> secret -> kind-specific parsing.
 * Secret-suspect and binary files are skipped BEFORE any indexing.
 */
export function parseFile(path: string, rawText: string, options: ParseOptions): ParseResult {
  const kind = classifyPath(path);
  if (kind === 'skip') {
    return { skipped: true, reason: 'unsupported-kind', detail: `no parser for ${path}` };
  }
  if (rawText.length > options.maxBytes) {
    return { skipped: true, reason: 'too-large', detail: `${path} exceeds ${options.maxBytes} bytes` };
  }
  if (looksBinary(rawText)) {
    return { skipped: true, reason: 'binary', detail: `${path} looks binary` };
  }
  if (looksLikeSecret(rawText)) {
    return {
      skipped: true,
      reason: 'secret-suspect',
      detail: `${path} matched a secret pattern; not indexed`,
    };
  }

  if (kind === 'manifest') {
    const format = MANIFEST_FILES[basename(path).toLowerCase()] ?? 'bukkit';
    const manifest = parseManifest(format, rawText);
    // Summary is indexed; raw manifest follows for exact-key search.
    const text = `${renderManifestText(manifest, options.repoId, path)}\n\n--- raw manifest ---\n${rawText}`;
    return {
      skipped: false,
      kind,
      text,
      symbols: [],
      manifest,
      contentType: 'text/plugin-manifest',
    };
  }

  if (kind === 'code') {
    const language = languageForPath(path);
    const symbols = extractSymbols(language, rawText);
    const header =
      symbols.length > 0
        ? `# symbols: ${symbols.map((s) => s.name).join(', ')}\n`
        : '';
    return {
      skipped: false,
      kind,
      text: `${header}${rawText}`,
      symbols,
      contentType: 'text/code',
    };
  }

  return {
    skipped: false,
    kind,
    text: rawText,
    symbols: [],
    contentType: kind === 'doc' ? 'text/markdown' : 'text/plain',
  };
}
