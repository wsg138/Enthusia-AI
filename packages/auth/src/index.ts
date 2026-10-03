/**
 * @enthusia/auth — authentication and authorization for Enthusia AI services.
 *
 * SKELETON (W01). Full implementation lands with W02 (AI Gateway):
 * request authentication, per-surface API keys, staff role checks against
 * the Visibility model, and rate-limit identity binding.
 *
 * Placeholder only — do not depend on these signatures yet.
 */

export interface AuthContext {
  /** Authenticated principal identity. */
  principalId: string;
  /** Granted roles/scopes. */
  roles: string[];
}

/** Placeholder: always rejects until the real implementation lands. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function authenticate(_token: string): Promise<AuthContext> {
  throw new Error('@enthusia/auth is a W01 skeleton — not implemented yet (see W02).');
}

export const AUTH_PLACEHOLDER = true;
