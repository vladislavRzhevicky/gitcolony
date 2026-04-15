import { createHash } from 'node:crypto';

// ============================================================================
// Node-only: deriveSeed uses `node:crypto`. Callers that run in the browser
// must import `createRng` / `pick` from `./rng.js` instead — this module is
// intentionally excluded from the client bundle via the `./sim` subpath in
// the package exports.
// ============================================================================

/**
 * Deterministic world seed derived from repo identity.
 * Same repo full name => same seed, across machines, users, and re-generations.
 * This is what makes share-by-URL reproducible.
 */
export function deriveSeed(repoFullName: string): string {
  return createHash('sha256')
    .update(`gitcolony:v1:${repoFullName.toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

// Re-export the RNG helpers so existing server-side imports of
// `@gitcolony/core` / `@gitcolony/core/seed` (api, worker, world-gen)
// keep working without edits.
export { createRng, pick } from './rng.js';
