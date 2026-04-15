import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { fetchApi } from '$lib/server/api';

// Fetches the caller's colony list so the dashboard can render cards on first
// paint (no client-side loading flash). The list endpoint is cheap — it joins
// city_worlds for stats but doesn't pull the heavy world jsonb.
export const load: PageServerLoad = async ({ cookies, locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  const res = await fetchApi('/cities', cookies);
  const data = res.ok ? await res.json().catch(() => ({ cities: [] })) : { cities: [] };
  return { user: locals.user, cities: data.cities ?? [] };
};
