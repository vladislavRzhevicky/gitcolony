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

export const GET: RequestHandler = async ({ cookies, locals, setHeaders }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const res = await fetchApi('/me/repos', cookies, { method: 'GET' });
  const cc = res.headers.get('cache-control');
  if (cc) setHeaders({ 'cache-control': cc });

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
};
