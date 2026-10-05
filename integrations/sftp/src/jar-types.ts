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

export function emptyPlugin(status: PluginMetadata['status']): PluginMetadata {
  return {
    status,
    dependencies: [],
    softDependencies: [],
    loadBefore: [],
    commands: [],
    permissions: [],
  };
}
