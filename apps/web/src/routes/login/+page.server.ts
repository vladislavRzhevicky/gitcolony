import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  PKCE_COOKIE,
  authClient,
  callbackUrl,
  pkceCookieOptions,
} from '$lib/server/auth';

// Already logged in? Skip straight to dashboard.
export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user) throw redirect(303, '/dashboard');
  return {};
};

export const actions: Actions = {
  // The login button is a form POST — no dedicated /auth/github/start page.
  // The action kicks off the PKCE flow and redirects the browser to the
  // issuer's authorize URL, which in turn hands off to GitHub.
  default: async ({ url, cookies }) => {
    const client = authClient();
    const { url: authorizeUrl, challenge } = await client.authorize(
      callbackUrl(url.origin),
      'code',
      { pkce: true },
    );

    // OpenAuth only returns a verifier when PKCE was actually negotiated;
    // we just asked for it, so treat a missing value as a server bug.
    if (!challenge.verifier) {
      throw new Error('openauth did not return a PKCE verifier');
    }

    cookies.set(
      PKCE_COOKIE,
      challenge.verifier,
      pkceCookieOptions(url.protocol === 'https:'),
    );

    throw redirect(303, authorizeUrl);
  },
};
