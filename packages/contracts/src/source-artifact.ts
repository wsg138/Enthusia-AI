import { z } from 'zod';
import { Visibility } from './visibility.js';
import { SourceType } from './source-types.js';

/**
 * Source artifact — raw/parsed evidence in the knowledge pipeline.
 *
 * Spec: MASTER-SPECIFICATION.md §50.
 */
export interface ContentMetadata {
  /** MIME type or short content kind, e.g. 'text/markdown'. */
  contentType: string;
  /** Human-readable title when available. */
  title?: string;
  /** Size in bytes when known. */
  sizeBytes?: number;
  /** Language tag (BCP 47) for text content. */
  language?: string;
  /** Parser-specific metadata. */
  extra?: Record<string, unknown>;
}

export interface SourceArtifact {
  /** Stable artifact identity. */
  artifactId: string;
  sourceType: SourceType;
  /** Locates the source: e.g. 'github:wsg138/EnthusiaStaff@<sha>:path/to/file'. */
  sourceLocator: string;
  /** Subsystem that produced/owns the artifact (e.g. 'knowledge-indexer'). */
  component: string;
  visibility: Visibility;
  /** Who/what asserts this artifact (e.g. 'github', 'staff:<id>', 'indexer'). */
  authority: string;
  /** Version or content hash of the source at observation time. */
  version: string;
  /** ISO 8601 — when the source was observed. */
  observedTime: string;
  /** ISO 8601 — when the artifact was indexed. */
  indexedTime: string;
  /** True when this is the latest indexed artifact for its identity. */
  current: boolean;
  contentMetadata?: ContentMetadata;
  /** Parser name+version that produced this artifact. */
  parserVersion?: string;
  /** Embedding model+version used for this artifact. */
  embeddingVersion?: string;
}

const contentMetadataSchema = z.object({
  contentType: z.string().min(1),
  title: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  language: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export const sourceArtifactSchema = z.object({
  artifactId: z.string().min(1),
  sourceType: z.nativeEnum(SourceType),
  sourceLocator: z.string().min(1),
  component: z.string().min(1),
  visibility: z.nativeEnum(Visibility),
  authority: z.string().min(1),
  version: z.string().min(1),
  observedTime: z.string().datetime({ offset: true }),
  indexedTime: z.string().datetime({ offset: true }),
  current: z.boolean(),
  contentMetadata: contentMetadataSchema.optional(),
  parserVersion: z.string().optional(),
  embeddingVersion: z.string().optional(),
});

export type SourceArtifactInput = z.input<typeof sourceArtifactSchema>;
