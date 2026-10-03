/**
 * @enthusia/source-provenance — errors.
 *
 * Registry-specific error types. Contract-level errors (validation, not-found)
 * come from @enthusia/contracts; these cover registry lifecycle failures.
 */

export class SourceRegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SourceRegistryError';
    this.code = code;
  }
}

/** An artifact id is unknown to the registry. */
export class ArtifactNotFoundError extends SourceRegistryError {
  constructor(artifactId: string) {
    super('ARTIFACT_NOT_FOUND', `source artifact not found: ${artifactId}`);
    this.name = 'ArtifactNotFoundError';
  }
}

/** A lifecycle transition is not allowed (e.g. superseding an INVALID artifact). */
export class InvalidTransitionError extends SourceRegistryError {
  constructor(artifactId: string, from: string, event: string) {
    super(
      'INVALID_TRANSITION',
      `cannot apply ${event} to artifact ${artifactId} in state ${from}`,
    );
    this.name = 'InvalidTransitionError';
  }
}

/** An artifact would be registered with SECRET_DENY visibility (§17.6: never indexed). */
export class SecretDenyRejectedError extends SourceRegistryError {
  constructor(sourceLocator: string) {
    super(
      'SECRET_DENY_REJECTED',
      `refusing to index artifact with SECRET_DENY visibility: ${sourceLocator}`,
    );
    this.name = 'SecretDenyRejectedError';
  }
}

/** A locator does not parse or its scheme mismatches its source type. */
export class InvalidLocatorError extends SourceRegistryError {
  constructor(locator: string, reason: string) {
    super('INVALID_LOCATOR', `invalid source locator ${JSON.stringify(locator)}: ${reason}`);
    this.name = 'InvalidLocatorError';
  }
}
