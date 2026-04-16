import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

// Proxy to apps/api /llm-keys. Mirrors the token proxy so the browser only
// ever talks to its own origin — the API handles validation + encryption.

async function proxy(res: Response) {
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
}

export const GET: RequestHandler = async ({ cookies, locals }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const res = await fetchApi('/llm-keys', cookies, { method: 'GET' });
  return proxy(res);
};

export const POST: RequestHandler = async ({ cookies, locals, request }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const body = await request.text();
  const res = await fetchApi('/llm-keys', cookies, { method: 'POST', body });
  return proxy(res);
};
