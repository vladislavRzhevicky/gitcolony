import { createClient } from '@openauthjs/openauth/client';
import { env } from '$env/dynamic/public';

// ============================================================================
// OpenAuth client for the web app.
//
// Single source of truth for:
//   - the OpenAuth client instance (clientID="web")
//   - the redirectURI we present to the issuer
//   - session cookie name + options
//
// Kept in `$lib/server` so SvelteKit guarantees none of this ever ships to the
// browser. The server is the only side that holds tokens.
// ============================================================================

const AUTH_URL = env.PUBLIC_AUTH_URL;

let cached: ReturnType<typeof createClient> | null = null;

export function authClient(): ReturnType<typeof createClient> {
  if (!AUTH_URL) {
    throw new Error(
      'PUBLIC_AUTH_URL is not set — cannot talk to the OpenAuth issuer.',
    );
  }
  if (!cached) {
    cached = createClient({ clientID: 'web', issuer: AUTH_URL });
  }
  return cached;
}

export function callbackUrl(origin: string): string {
  return `${origin}/auth/callback`;
}

export const SESSION_COOKIE = 'session';
export const PKCE_COOKIE = 'pkce_verifier';

/** Cookie options for the long-lived access token. */
export function sessionCookieOptions(secure: boolean) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: 60 * 60 * 24 * 7, // 1 week — user re-auths weekly
  };
}

/** Cookie options for the short-lived PKCE verifier. */
export function pkceCookieOptions(secure: boolean) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: 60 * 10, // 10 min — one round trip to GitHub is plenty
  };
}
