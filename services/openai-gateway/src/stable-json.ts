const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function escapeJsonCharacter(value: string): string {
  const known = JSON_ESCAPES[value];
  if (known !== undefined) return known;
  const code = value.charCodeAt(0);
  return code < 32
    ? '\\u' + code.toString(16).padStart(4, '0')
    : value;
}

function quoteJson(value: string): string {
  return '"' + Array.from(value, escapeJsonCharacter).join('') + '"';
}

function scalarJson(value: unknown): string | undefined {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return quoteJson(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'number') return undefined;
  return Number.isFinite(value) ? String(value) : 'null';
}

function objectJson(value: Record<string, unknown>): string {
  const fields = Object.keys(value)
    .sort()
    .map((key) => quoteJson(key) + ':' + stableJson(value[key]));
  return '{' + fields.join(',') + '}';
}

/** Deterministic JSON encoding for bounded model prompts and audit fixtures. */
export function stableJson(value: unknown): string {
  const scalar = scalarJson(value);
  if (scalar !== undefined) return scalar;
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableJson(item)).join(',') + ']';
  }
  if (typeof value === 'object' && value !== null) {
    return objectJson(value as Record<string, unknown>);
  }
  return 'null';
}
