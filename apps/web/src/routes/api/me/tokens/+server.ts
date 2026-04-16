import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

// Proxy to apps/api /tokens. The backend owns encryption and viewer
// validation — this file just forwards the session cookie and the body.

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
  const res = await fetchApi('/tokens', cookies, { method: 'GET' });
  return proxy(res);
};

export const POST: RequestHandler = async ({ cookies, locals, request }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const body = await request.text();
  const res = await fetchApi('/tokens', cookies, { method: 'POST', body });
  return proxy(res);
};
