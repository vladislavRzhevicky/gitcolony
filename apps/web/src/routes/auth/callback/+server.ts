import { redirect } from '@sveltejs/kit';
import { log } from '@gitcolony/log';
import type { RequestHandler } from './$types';
import {
  PKCE_COOKIE,
  SESSION_COOKIE,
  authClient,
  callbackUrl,
  sessionCookieOptions,
} from '$lib/server/auth';

// ============================================================================
// OAuth callback.
//
// The issuer redirects the browser here with ?code=... after GitHub finishes.
// We exchange the code for tokens (using the PKCE verifier we stashed in the
// cookie when the flow started), drop a session cookie, and send the user to
// the dashboard.
//
// On any failure we send them back to /login — no leaking internal errors to
// the URL. Detailed diagnostics stay server-side via console.
// ============================================================================

export const GET: RequestHandler = async ({ url, cookies }) => {
  const code = url.searchParams.get('code');
  const verifier = cookies.get(PKCE_COOKIE);
  cookies.delete(PKCE_COOKIE, { path: '/' });

  if (!code || !verifier) {
    throw redirect(303, '/login?error=missing_code');
  }

  const client = authClient();
  const result = await client.exchange(code, callbackUrl(url.origin), verifier);

  if (result.err) {
    log.error('openauth exchange failed', result.err);
    throw redirect(303, '/login?error=exchange_failed');
  }

  cookies.set(
    SESSION_COOKIE,
    result.tokens.access,
    sessionCookieOptions(url.protocol === 'https:'),
  );

  throw redirect(303, '/dashboard');
};
