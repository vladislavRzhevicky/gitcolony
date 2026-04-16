import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

// ============================================================================
// GET /api/me/repos — proxy to apps/api. Adds the OpenAuth session cookie
// as a Bearer header so the browser never touches the access token.
//
// We deliberately *don't* throw on upstream non-2xx — the dialog renders
// the error message inline. We also guard against non-JSON bodies so an
// upstream stack trace doesn't get masked by a JSON.parse failure here.
// ============================================================================

async function proxy(
  res: Response,
  setHeaders?: (h: Record<string, string>) => void,
) {
  const cc = res.headers.get('cache-control');
  if (cc && setHeaders) setHeaders({ 'cache-control': cc });
  const text = await res.text();
  try {
    return json(JSON.parse(text), { status: res.status });
  } catch {
    // Surface the upstream raw body so we can see what actually broke
    // instead of a SvelteKit 500 with no detail.
    return json(
      { error: `upstream ${res.status}: ${text.slice(0, 500)}` },
      { status: res.status >= 400 ? res.status : 502 },
    );
  }
}

export const GET: RequestHandler = async ({ cookies, locals, setHeaders }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const res = await fetchApi('/me/repos', cookies, { method: 'GET' });
  return proxy(res, setHeaders);
};

// POST variant: the body carries a caller-supplied PAT. We never persist it
// — apps/api uses it for exactly one GraphQL call and forgets. Not cached,
// so each open of the Advanced section re-validates the token.
export const POST: RequestHandler = async ({ cookies, locals, request }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const body = await request.text();
  const res = await fetchApi('/me/repos', cookies, { method: 'POST', body });
  return proxy(res);
};
