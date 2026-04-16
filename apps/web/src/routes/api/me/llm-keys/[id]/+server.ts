import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

export const DELETE: RequestHandler = async ({ cookies, locals, params }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const res = await fetchApi(`/llm-keys/${params.id}`, cookies, {
    method: 'DELETE',
  });
  return new Response(null, { status: res.status });
};
