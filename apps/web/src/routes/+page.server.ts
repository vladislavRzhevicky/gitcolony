import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Logged-in users skip the landing — dashboard is the main surface for them.
export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user) throw redirect(303, '/dashboard');
  return {};
};
