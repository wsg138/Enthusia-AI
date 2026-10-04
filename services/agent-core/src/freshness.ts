/**
 * @enthusia/agent-core — freshness convention (W12).
 *
 * The wire `ToolResult.freshness` field is a free-form string (§16.2), but
 * claim verification (§11) needs structured provenance: version, observation
 * time, and source lifecycle status. This module defines the convention
 * agent-core tools use:
 *
 * - Preferred: `freshness` carries JSON of {@link FreshnessInfo}
 *   (`{"version":"<sha|hash>","observedTime":"<ISO-8601>","sourceStatus":"CURRENT"}`).
 * - Fallback: a bare version string (e.g. `"9f3c2a"`). It is interpreted as
 *   `{ version, observedTime: <envelope timestamp>, sourceStatus: CURRENT }`
 *   — i.e. the tool asserts the version was current when the tool ran.
 *
 * Tools that cannot assert currency should omit `freshness` (or report a
 * non-CURRENT status): their results stay in the investigation trace but
 * never ground a factual answer (§11.3).
 */
import { SourceStatus } from '@enthusia/contracts';

/** Structured freshness: claim -> source -> version/time -> status (§11.3). */
export interface FreshnessInfo {
  /** Version fingerprint (SHA, hash, revision, ...). */
  version: string;
  /** ISO-8601 timestamp when the source was observed. */
  observedTime: string;
  /** Lifecycle status of the source version. */
  sourceStatus: SourceStatus;
}

/** Encode structured freshness for `ToolResult.freshness`. */
export function encodeFreshness(info: FreshnessInfo): string {
  return JSON.stringify({
    version: info.version,
    observedTime: info.observedTime,
    sourceStatus: info.sourceStatus,
  });
}

/**
 * Decode `ToolResult.freshness` into structured info.
 *
 * @param raw the raw freshness string (may be undefined).
 * @param fallbackObservedTime ISO-8601 timestamp to use when the raw value
 *   is a bare version string (normally the envelope `timestamp`).
 * @returns structured info, or null when currency cannot be established.
 */
export function decodeFreshness(
  raw: string | undefined,
  fallbackObservedTime?: string,
): FreshnessInfo | null {
  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }
  const parsed = tryParseJson(raw);
  if (parsed) {
    return parsed;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    // Looks like structured freshness but failed validation: do not silently
    // reinterpret it as a bare version string (fail closed, §11.3).
    return null;
  }
  // Bare version string: the tool asserts this version was current when it ran.
  return {
    version: raw.trim(),
    observedTime:
      fallbackObservedTime && fallbackObservedTime.trim().length > 0
        ? fallbackObservedTime
        : new Date(0).toISOString(),
    sourceStatus: SourceStatus.CURRENT,
  };
}

function tryParseJson(raw: string): FreshnessInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const version = record['version'];
  const observedTime = record['observedTime'];
  const sourceStatus = record['sourceStatus'];
  if (
    typeof version !== 'string' ||
    version.trim().length === 0 ||
    typeof observedTime !== 'string' ||
    typeof sourceStatus !== 'string' ||
    !isSourceStatus(sourceStatus)
  ) {
    return null;
  }
  return {
    version: version.trim(),
    observedTime,
    sourceStatus: sourceStatus as SourceStatus,
  };
}

function isSourceStatus(value: string): boolean {
  return (Object.values(SourceStatus) as string[]).includes(value);
}
