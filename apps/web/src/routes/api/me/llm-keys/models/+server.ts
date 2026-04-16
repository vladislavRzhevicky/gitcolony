import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

// Fetches the live Gemini model list for the given API key by proxying to
// apps/api. Kept behind the auth wall even though the API call itself is
// stateless — this way we don't expose an unauthenticated endpoint that
// could be abused to probe key validity.
export const POST: RequestHandler = async ({ cookies, locals, request }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const body = await request.text();
  const res = await fetchApi('/llm-keys/models', cookies, {
    method: 'POST',
    body,
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
