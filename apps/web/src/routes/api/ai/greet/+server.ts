import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

// Proxy to apps/api /ai/greet. Mirrors the llm-keys proxy so the browser
// never forwards credentials on its own — auth lives in the session cookie
// and `fetchApi` attaches the Bearer header on the way out.
//
// We deliberately surface upstream non-2xx statuses (404, 412, 429, 502)
// so the sim can decide whether to fall back to canned phrases or skip.

export const POST: RequestHandler = async ({ cookies, locals, request }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const body = await request.text();
  const res = await fetchApi('/ai/greet', cookies, { method: 'POST', body });
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
