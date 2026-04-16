import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

// Proxy to apps/api /ai/review. Same contract as /ai/greet — the session
// cookie authenticates the caller; `fetchApi` attaches the Bearer header.
// A 204 is a legitimate "no reviewable snippet in this commit" signal; the
// client falls back to a regular greeting when it sees it.

export const POST: RequestHandler = async ({ cookies, locals, request }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const body = await request.text();
  const res = await fetchApi('/ai/review', cookies, { method: 'POST', body });
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
