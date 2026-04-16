import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

export const POST: RequestHandler = async ({ cookies, locals, params }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const res = await fetchApi(`/llm-keys/${params.id}/activate`, cookies, {
    method: 'POST',
  });
  const text = await res.text();
  if (text.length === 0) return new Response(null, { status: res.status });
  try {
    return json(JSON.parse(text), { status: res.status });
  } catch {
    return json(
      { error: `upstream ${res.status}: ${text.slice(0, 500)}` },
      { status: res.status >= 400 ? res.status : 502 },
    );
  }
};
