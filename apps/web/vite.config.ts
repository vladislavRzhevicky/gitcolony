import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Monorepo .env lives at the repo root so every app (api, auth, web) sees the
// same shared values. Point Vite at it instead of apps/web/.env.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  envDir: repoRoot,
  plugins: [sveltekit()],
});
