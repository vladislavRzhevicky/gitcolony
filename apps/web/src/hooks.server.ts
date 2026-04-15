import type { Handle } from '@sveltejs/kit';
import { verifyAccessToken } from '@gitcolony/auth/verify';
import { env } from '$env/dynamic/public';
import { SESSION_COOKIE } from '$lib/server/auth';

// `@gitcolony/auth/verify` reads `process.env.PUBLIC_AUTH_URL` directly (it is
// shared with apps/api which runs on plain Node). SvelteKit's dev server loads
// .env into its own `$env/*` module but not into `process.env`, so mirror the
// value across here once on module init.
if (env.PUBLIC_AUTH_URL && !process.env.PUBLIC_AUTH_URL) {
  process.env.PUBLIC_AUTH_URL = env.PUBLIC_AUTH_URL;
}

// ============================================================================
// Request-scoped auth resolver.
//
// Runs on every server request before any route `load` / action executes.
// If there's a session cookie, verify it once via the OpenAuth client and
// hang the resulting subject off `event.locals.user`. Routes then just read
// `locals.user` without knowing anything about JWTs.
// ============================================================================

export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get(SESSION_COOKIE);
  if (token) {
    try {
      const subject = await verifyAccessToken(token);
      if (subject) event.locals.user = subject;
    } catch {
      // Invalid / expired token -> treat as anonymous. Route-level redirects
      // handle the "please log in" case; we don't need to do it here.
    }
  }
  return resolve(event);
};
