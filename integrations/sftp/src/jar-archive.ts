/**
 * Bounded ZIP reader for plugin JAR metadata.
 *
 * Only explicitly allowlisted metadata entries are materialized. No entry is
 * written to disk and no class is loaded or executed.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_METADATA_ENTRIES = 32;
const MAX_COMPRESSION_RATIO = 200;

const EXACT_METADATA_ENTRIES = new Set([
  'plugin.yml',
  'paper-plugin.yml',
  'velocity-plugin.json',
  'META-INF/MANIFEST.MF',
  'git.properties',
  'META-INF/git.properties',
]);

interface ZipEntry {
  name: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
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

function parseCentralEntry(
  buffer: Buffer,
  offset: number,
): { entry: ZipEntry; next: number } {
  assertRange(buffer, offset, 46);
  if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
    throw new Error('invalid central-directory signature');
  }

  const nameLength = buffer.readUInt16LE(offset + 28);
  const extraLength = buffer.readUInt16LE(offset + 30);
  const commentLength = buffer.readUInt16LE(offset + 32);
  const fullLength = 46 + nameLength + extraLength + commentLength;
  assertRange(buffer, offset, fullLength);

  return {
    entry: {
      name: buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      flags: buffer.readUInt16LE(offset + 8),
      compressionMethod: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    },
    next: offset + fullLength,
  };
}

function parseDirectory(buffer: Buffer): ZipEntry[] {
  const eocd = findEocd(buffer);
  assertRange(buffer, eocd, 22);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('zip64 metadata is not supported');
  }
  if (totalEntries > MAX_ARCHIVE_ENTRIES) throw new Error('archive entry limit exceeded');
  assertRange(buffer, centralOffset, centralSize);

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    const parsed = parseCentralEntry(buffer, cursor);
    entries.push(parsed.entry);
    cursor = parsed.next;
  }
  if (cursor > centralOffset + centralSize) throw new Error('central directory overflow');
  return entries;
}

function assertCompressionBudget(entry: ZipEntry, maxBytes: number): void {
  if (entry.uncompressedSize > maxBytes) throw new Error('metadata entry too large');
  if (entry.uncompressedSize === 0) return;
  if (entry.compressedSize === 0) throw new Error('invalid compressed metadata entry');
  if (entry.uncompressedSize > entry.compressedSize * MAX_COMPRESSION_RATIO) {
    throw new Error('metadata compression ratio exceeded');
  }
}

function readZipEntry(buffer: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if ((entry.flags & 0x1) !== 0) throw new Error('encrypted zip entry');
  assertCompressionBudget(entry, maxBytes);

  const offset = entry.localHeaderOffset;
  assertRange(buffer, offset, 30);
  if (buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new Error('invalid local header');
  }

  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  assertRange(buffer, dataOffset, entry.compressedSize);
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod !== 8) throw new Error('unsupported zip compression');
  return inflateRawSync(compressed, { maxOutputLength: maxBytes });
}

function metadataEntryAllowed(name: string): boolean {
  if (EXACT_METADATA_ENTRIES.has(name)) return true;
  const lower = name.toLowerCase();
  return lower.endsWith('/git.properties') || lower.endsWith('/pom.properties');
}

export function extractJarMetadataEntries(
  jar: Buffer,
  maxEntryBytes: number,
): Map<string, string> {
  const result = new Map<string, string>();
  let totalBytes = 0;

  for (const entry of parseDirectory(jar)) {
    if (!metadataEntryAllowed(entry.name) || result.has(entry.name)) continue;
    if (result.size >= MAX_METADATA_ENTRIES) throw new Error('metadata entry count exceeded');

    const bytes = readZipEntry(jar, entry, maxEntryBytes);
    totalBytes += bytes.length;
    if (totalBytes > maxEntryBytes * 8) throw new Error('metadata budget exceeded');
    result.set(entry.name, bytes.toString('utf8'));
  }
  return result;
}
