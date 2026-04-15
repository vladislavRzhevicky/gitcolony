import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SESSION_COOKIE } from '$lib/server/auth';

// POST only — logout is a state-changing action, not a GET side-effect.
export const POST: RequestHandler = async ({ cookies }) => {
  cookies.delete(SESSION_COOKIE, { path: '/' });
  throw redirect(303, '/');
};
