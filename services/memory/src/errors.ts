/**
 * @enthusia/memory — error types (W05).
 */

export class MemoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

/** Referenced memory key does not exist. */
export class MemoryKeyNotFoundError extends MemoryError {
  constructor(ref: string) {
    super('MEMORY_KEY_NOT_FOUND', `Memory key not found: ${ref}`);
  }
}

/** Referenced revision does not exist. */
export class MemoryRevisionNotFoundError extends MemoryError {
  constructor(id: string) {
    super('MEMORY_REVISION_NOT_FOUND', `Memory revision not found: ${id}`);
  }
}

/** A CURRENT revision already exists; use supersede() to replace it. */
export class CurrentRevisionExistsError extends MemoryError {
  constructor(ref: string) {
    super(
      'CURRENT_REVISION_EXISTS',
      `A CURRENT revision already exists for ${ref}; supersede it instead of creating a second one.`,
    );
  }
}

/** No active (CURRENT or CONFLICTED) revision to transition from. */
export class NoActiveRevisionError extends MemoryError {
  constructor(ref: string) {
    super(
      'NO_ACTIVE_REVISION',
      `No active (CURRENT/CONFLICTED) revision exists for ${ref}.`,
    );
  }
}

/**
 * Optimistic-concurrency failure: the CURRENT revision changed between the
 * caller's read and the supersession attempt. The caller should re-read and
 * retry if it still intends to replace the new current value.
 */
export class ConcurrentModificationError extends MemoryError {
  readonly expectedId: string;
  readonly actualId: string | null;
  constructor(expectedId: string, actualId: string | null) {
    super(
      'CONCURRENT_MODIFICATION',
      `Expected current revision ${expectedId} but found ${actualId ?? 'none'}; refusing to supersede a revision the caller never saw.`,
    );
    this.expectedId = expectedId;
    this.actualId = actualId;
  }
}

/** Input failed contract validation. */
export class MemoryValidationError extends MemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('MEMORY_VALIDATION_ERROR', message, options);
  }
}
