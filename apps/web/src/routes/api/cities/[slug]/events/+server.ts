import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchApi } from '$lib/server/api';

// ============================================================================
// SSE passthrough for /cities/:slug/events.
//
// We stream the upstream response body directly — no JSON parsing, no
// buffering. Headers are normalized to text/event-stream so SvelteKit's
// adapter does not try to gzip / chunk-transform the frames.
// ============================================================================

export const GET: RequestHandler = async ({ params, cookies, locals, request }) => {
  if (!locals.user) throw error(401, 'unauthorized');
  const upstream = await fetchApi(`/cities/${params.slug}/events`, cookies, {
    method: 'GET',
    signal: request.signal,
  });
  if (!upstream.ok || !upstream.body) {
    throw error(upstream.status || 502, 'upstream events failed');
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
};
