/**
 * @enthusia/memory — current memory + historical revisions service (W05).
 *
 * Spec: MASTER-SPECIFICATION.md §§13, 49 and
 * MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md.
 */

export { MemoryService } from './memory-service.js';
export type { MemoryServiceOptions } from './memory-service.js';
export { SCHEMA_DDL } from './schema.js';
export {
  MemoryError,
  MemoryKeyNotFoundError,
  MemoryRevisionNotFoundError,
  CurrentRevisionExistsError,
  NoActiveRevisionError,
  ConcurrentModificationError,
  MemoryValidationError,
} from './errors.js';
export type {
  MemoryKey,
  MemoryRevision,
  MemoryEvidence,
  MemoryRevisionStatus,
  MemoryRef,
  EvidenceInput,
  StoredRevision,
  CurrentMemory,
  CreateRevisionInput,
  SupersedeInput,
  InvalidateInput,
  ReportConflictInput,
  CorrectionInput,
  CacheInvalidator,
  MemoryEventType,
  MemoryEvent,
  MemoryEventListener,
} from './types.js';
export { EvidenceRole, SourceStatus, Visibility } from './types.js';
