import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

// Proxy to apps/api /ai/intent. Mirrors /api/ai/greet — the browser never
// forwards credentials on its own; session cookie stays server-side and
// `fetchApi` attaches the Bearer header on the way out.
//
// Upstream non-2xx statuses (404, 412, 429, 502) are surfaced unchanged
// so the client director can decide whether to back off, fall back to
// wander, or skip entirely.

export const POST: RequestHandler = async ({ cookies, locals, request }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const body = await request.text();
  const res = await fetchApi('/ai/intent', cookies, { method: 'POST', body });
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
