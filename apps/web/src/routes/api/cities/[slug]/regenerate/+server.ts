import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

// POST /api/cities/:slug/regenerate — drops the world and enqueues a fresh
// initial job. Used by the city page header control.
export const POST: RequestHandler = async ({ params, cookies, locals }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const res = await fetchApi(`/cities/${params.slug}/regenerate`, cookies, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  return json(data, { status: res.status });
};
