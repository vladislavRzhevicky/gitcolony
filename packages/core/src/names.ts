// ============================================================================
// Agent names — two hardcoded pools combined into "First Last" pairs.
//
// Deterministic by agent id: same agent always gets the same pair across
// sessions and machines, so the name surface is stable without needing
// another LLM round-trip. Styled to read as a codename / science-hero
// handle (e.g. "Ada Drift", "Turing Onyx") — fits the city-chatter tone
// on the scene.
// ============================================================================

export const FIRST_NAMES: readonly string[] = [
  'Ada', 'Galileo', 'Edison', 'Curie', 'Tesla', 'Turing', 'Newton', 'Darwin',
  'Hopper', 'Nobel', 'Volta', 'Morse', 'Pascal', 'Watt', 'Kepler', 'Hertz',
  'Ohm', 'Faraday', 'Boyle', 'Lovelace', 'Babbage', 'Euler', 'Gauss', 'Fermi',
  'Bohr', 'Planck', 'Hawking', 'Feynman', 'Dirac', 'Einstein', 'Leibniz',
  'Hubble', 'Kelvin', 'Meitner', 'Lamarr', 'Ritchie', 'Knuth', 'Shannon',
  'Noether', 'Wiener', 'Nova', 'Echo', 'Onyx', 'Mira', 'Flare', 'Rune',
  'Orion', 'Vega', 'Cosmo', 'Zephyr',
];

export const LAST_NAMES: readonly string[] = [
  'Drift', 'Spark', 'Frost', 'Ember', 'Crag', 'Reef', 'Mirage', 'Hex',
  'Vane', 'Wraith', 'Phantom', 'Shade', 'Pulse', 'Haze', 'Cinder', 'Quartz',
  'Prism', 'Rift', 'Aether', 'Vortex', 'Comet', 'Nebula', 'Quasar', 'Orbit',
  'Stellar', 'Dune', 'Ridge', 'Basin', 'Delta', 'Fjord', 'Cove', 'Cliff',
  'Mesa', 'Shoal', 'Helix', 'Vector', 'Byte', 'Chord', 'Opal', 'Jade',
  'Crimson', 'Violet', 'Amber', 'Ivory', 'Sable', 'Azure', 'Coral', 'Topaz',
  'Glint', 'Beacon',
];

/**
 * Deterministic "First Last" pair for an agent id. Two independent FNV-1a
 * hashes (different salts) so first and last components vary independently
 * across the 50×50 = 2500 combinations.
 */
export function pickAgentName(id: string): string {
  const first = FIRST_NAMES[hashWithSalt(id, 'first') % FIRST_NAMES.length]!;
  const last = LAST_NAMES[hashWithSalt(id, 'last') % LAST_NAMES.length]!;
  return `${first} ${last}`;
}

function hashWithSalt(s: string, salt: string): number {
  let h = 2166136261 >>> 0;
  const str = `${s}|${salt}`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
