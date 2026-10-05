import {
  emptyPlugin,
  type PluginMetadata,
} from './jar-types.js';

interface VelocityDependency {
  id: string;
  optional: boolean;
}

interface VelocityIdentity {
  name: string;
  version: string;
  mainClass: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseDependency(value: unknown): VelocityDependency | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const id = asString(record.id);
  if (id === undefined) return undefined;
  return { id, optional: record.optional === true };
}

function addDependency(
  dependency: VelocityDependency,
  required: string[],
  optional: string[],
): void {
  if (dependency.optional) optional.push(dependency.id);
  else required.push(dependency.id);
}

function dependencyLists(value: unknown): {
  required: string[];
  optional: string[];
} {
  const required: string[] = [];
  const optional: string[] = [];
  if (!Array.isArray(value)) return { required, optional };

  for (const raw of value) {
    const dependency = parseDependency(raw);
    if (dependency !== undefined) addDependency(dependency, required, optional);
  }
  return { required, optional };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function malformed(): PluginMetadata {
  return {
    ...emptyPlugin('MALFORMED'),
    descriptor: 'velocity-plugin.json',
    metadataError: 'invalid-descriptor',
  };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function identityFrom(data: Record<string, unknown>): VelocityIdentity | undefined {
  const name = asString(data.name) ?? asString(data.id);
  const version = asString(data.version);
  const mainClass = asString(data.main);
  if (name === undefined) return undefined;
  if (version === undefined) return undefined;
  if (mainClass === undefined) return undefined;
  return { name, version, mainClass };
}

export function parseVelocityDescriptor(text: string): PluginMetadata {
  const data = parseObject(text);
  if (data === undefined) return malformed();
  const identity = identityFrom(data);
  if (identity === undefined) return malformed();

  const dependencies = dependencyLists(data.dependencies);
  return {
    status: 'OK',
    descriptor: 'velocity-plugin.json',
    name: identity.name,
    version: identity.version,
    mainClass: identity.mainClass,
    dependencies: dependencies.required,
    softDependencies: dependencies.optional,
    loadBefore: stringArray(data.loadBefore),
    commands: [],
    permissions: [],
  };
}
