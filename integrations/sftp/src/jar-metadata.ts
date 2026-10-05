/**
 * Safe plugin JAR metadata extraction.
 *
 * Archive handling and descriptor parsing are separated so malformed metadata
 * cannot be confused with arbitrary code execution. Only a small metadata
 * entry allowlist is materialized.
 */

import { extractJarMetadataEntries } from './jar-archive.js';
import {
  parseBuildMetadata,
  parseBukkitDescriptor,
  parseVelocityDescriptor,
} from './jar-descriptor.js';
import {
  emptyPlugin,
  type JarBuildMetadata,
  type ParsedPluginJar,
  type PluginMetadata,
} from './jar-types.js';

export type {
  JarBuildMetadata,
  ParsedPluginJar,
  PluginDescriptorKind,
  PluginMetadata,
} from './jar-types.js';

function parsePluginMetadata(entries: Map<string, string>): PluginMetadata {
  const plugin = entries.get('plugin.yml');
  if (plugin !== undefined) return parseBukkitDescriptor(plugin, 'plugin.yml');

  const paper = entries.get('paper-plugin.yml');
  if (paper !== undefined) return parseBukkitDescriptor(paper, 'paper-plugin.yml');

  const velocity = entries.get('velocity-plugin.json');
  if (velocity !== undefined) return parseVelocityDescriptor(velocity);

  return emptyPlugin('MISSING');
}

function invalidArchive(): ParsedPluginJar {
  return {
    plugin: { ...emptyPlugin('MALFORMED'), metadataError: 'invalid-archive' },
    build: {},
    inspectedEntries: [],
  };
}

function invalidDescriptor(entries: Map<string, string>): ParsedPluginJar {
  return {
    plugin: { ...emptyPlugin('MALFORMED'), metadataError: 'invalid-descriptor' },
    build: safeBuildMetadata(entries),
    inspectedEntries: [...entries.keys()].sort(),
  };
}

function safeBuildMetadata(entries: Map<string, string>): JarBuildMetadata {
  try {
    return parseBuildMetadata(entries);
  } catch {
    return {};
  }
}

/**
 * Inspect a deployed JAR without executing it.
 *
 * Archive structure errors are reported as invalid-archive. Descriptor parser
 * limits/errors are reported separately as invalid-descriptor while preserving
 * any safe build metadata that can still be recovered.
 */
export function parsePluginJar(
  jar: Buffer,
  maxMetadataBytes = 512 * 1024,
): ParsedPluginJar {
  let entries: Map<string, string>;
  try {
    entries = extractJarMetadataEntries(jar, maxMetadataBytes);
  } catch {
    return invalidArchive();
  }

  let plugin: PluginMetadata;
  try {
    plugin = parsePluginMetadata(entries);
  } catch {
    return invalidDescriptor(entries);
  }

  return {
    plugin,
    build: safeBuildMetadata(entries),
    inspectedEntries: [...entries.keys()].sort(),
  };
}
