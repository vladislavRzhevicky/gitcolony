import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

// DELETE /api/cities/:slug — thin proxy. Returns 204 on success.
export const DELETE: RequestHandler = async ({ params, cookies, locals }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const res = await fetchApi(`/cities/${params.slug}`, cookies, { method: 'DELETE' });
  return new Response(null, { status: res.status });
};
