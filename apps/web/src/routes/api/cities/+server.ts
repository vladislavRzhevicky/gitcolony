import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

// ============================================================================
// /api/cities — thin proxies to apps/api.
// Keeps the OpenAuth access token cookie-bound: the browser never sees it.
// ============================================================================

export const GET: RequestHandler = async ({ cookies, locals }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const res = await fetchApi('/cities', cookies);
  const data = await res.json().catch(() => ({ cities: [] }));
  return json(data, { status: res.status });
};

export const POST: RequestHandler = async ({ request, cookies, locals }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const body = await request.text();
  const res = await fetchApi('/cities', cookies, { method: 'POST', body });
  const data = await res.json();
  return json(data, { status: res.status });
};
