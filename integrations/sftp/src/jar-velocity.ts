import {
  emptyPlugin,
  type PluginMetadata,
} from './jar-types.js';

function dependencyLists(value: unknown): {
  required: string[];
  optional: string[];
} {
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

export function parseVelocityDescriptor(text: string): PluginMetadata {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return malformed();
  }

  const name = typeof data.name === 'string'
    ? data.name
    : typeof data.id === 'string' ? data.id : undefined;
  const version = typeof data.version === 'string' ? data.version : undefined;
  const mainClass = typeof data.main === 'string' ? data.main : undefined;
  if (name === undefined || version === undefined || mainClass === undefined) {
    return malformed();
  }

  const dependencies = dependencyLists(data.dependencies);
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
