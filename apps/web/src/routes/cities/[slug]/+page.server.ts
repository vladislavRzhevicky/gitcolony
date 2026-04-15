import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { fetchApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ params, cookies, locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  const res = await fetchApi(`/cities/${params.slug}`, cookies);
  if (res.status === 404) throw error(404, 'city not found');
  if (!res.ok) throw error(res.status, `api error: ${await res.text()}`);
  const data = await res.json();
  return {
    user: locals.user,
    city: data.city,
    world: data.world,
    job: data.job,
    slug: params.slug,
  };
};
