import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // Shared monorepo .env lives at the repo root — tell SvelteKit's env
    // loader about it so `$env/*` sees DATABASE_URL, PUBLIC_AUTH_URL, etc.
    env: { dir: '../../' },
  },
};

export default config;
