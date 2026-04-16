import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { fetchApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ params, cookies, locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  // City + LLM-key status fetched in parallel. The second call is cheap and
  // determines whether the client sim wires up AI-driven chat or stays on
  // canned phrases — one less round trip after the page hydrates.
  const [cityRes, keysRes] = await Promise.all([
    fetchApi(`/cities/${params.slug}`, cookies),
    fetchApi('/llm-keys', cookies),
  ]);
  if (cityRes.status === 404) throw error(404, 'city not found');
  if (!cityRes.ok) throw error(cityRes.status, `api error: ${await cityRes.text()}`);
  const data = await cityRes.json();

  // Defaults to false on any upstream hiccup — "no LLM" is the safe fallback
  // and the sim still runs with mock phrases, so a transient /llm-keys error
  // doesn't break the page.
  let aiEnabled = false;
  if (keysRes.ok) {
    try {
      const body = (await keysRes.json()) as { activeKeyId?: string | null };
      aiEnabled = Boolean(body.activeKeyId);
    } catch {
      aiEnabled = false;
    }
  }

  return {
    user: locals.user,
    city: data.city,
    world: data.world,
    job: data.job,
    slug: params.slug,
    aiEnabled,
  };
};
