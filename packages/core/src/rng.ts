// ============================================================================
// Deterministic RNG + small pick helper.
//
// Browser-safe: no Node built-ins. Kept separate from `seed.ts` (which pulls
// `node:crypto` for `deriveSeed`) so the client bundle can consume the RNG
// without Vite externalizing node:crypto and blowing up at module init.
// ============================================================================

/**
 * Mulberry32 — tiny seeded PRNG. Good enough for layout/variant selection.
 * Keep this function stable: changing it invalidates existing worlds.
 */
export function createRng(seed: string): () => number {
  // fold the string seed into a uint32
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  let a = h >>> 0;
  return function mulberry32() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('pick(): empty array');
  const value = arr[Math.floor(rng() * arr.length)];
  if (value === undefined) throw new Error('pick(): unexpected undefined');
  return value;
}
