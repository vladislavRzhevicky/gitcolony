import { env } from '$env/dynamic/public';
import { SESSION_COOKIE } from './auth';
import type { Cookies } from '@sveltejs/kit';

// ============================================================================
// Server-side helper for calling apps/api on behalf of the current user.
//
// The browser never sees the OpenAuth access token — we read it from the
// session cookie here and forward it as a Bearer header. Works for both
// JSON calls (fetchApi) and SSE streams (same auth, but caller handles body).
// ============================================================================

export function apiBase(): string {
  const base = env.PUBLIC_API_URL;
  if (!base) throw new Error('PUBLIC_API_URL is not set');
  return base.replace(/\/$/, '');
}

export async function fetchApi(
  path: string,
  cookies: Cookies,
  init: RequestInit = {},
): Promise<Response> {
  const token = cookies.get(SESSION_COOKIE);
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return fetch(`${apiBase()}${path}`, { ...init, headers });
}
