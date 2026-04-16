import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { fetchApi } from '$lib/server/api';

// Settings page server load. Anonymous callers bounce to /login; everyone
// else gets a first-paint snapshot of saved tokens + LLM keys so each
// section doesn't flash in after hydration.
export const load: PageServerLoad = async ({ cookies, locals }) => {
  if (!locals.user) throw redirect(303, '/login');

  const [tokensRes, keysRes] = await Promise.all([
    fetchApi('/tokens', cookies),
    fetchApi('/llm-keys', cookies),
  ]);

  const tokensBody = tokensRes.ok
    ? await tokensRes.json().catch(() => ({ tokens: [] }))
    : { tokens: [] };
  const keysBody = keysRes.ok
    ? await keysRes.json().catch(() => ({ keys: [], activeKeyId: null }))
    : { keys: [], activeKeyId: null };

  return {
    user: locals.user,
    tokens: tokensBody.tokens ?? [],
    llmKeys: keysBody.keys ?? [],
    activeLlmKeyId: keysBody.activeKeyId ?? null,
  };
};
