// ============================================================================
// Asset registry — maps abstract variant keys produced by @gitcolony/core
// onto concrete GLB paths served from /static/models.
//
// The variant strings (e.g. 'workshop-01', 'tree-02') are contract surface
// between the generator and the renderer — invariant #2/#4 require them to
// stay stable across releases. The mapping below is *rendering-side only*:
// swapping models here doesn't invalidate existing worlds.
//
// Picking is deterministic: for a given (variant, stableKey) we always
// return the same GLB path. stableKey is typically commitSha (for objects)
// or agent.id (for agents) so the same colony always looks the same.
// ============================================================================

import type { WorldObject, Agent, SceneryProp } from '@gitcolony/schema';

// ----------------------------------------------------------------------------
// Deterministic, non-cryptographic hash. FNV-1a 32-bit is plenty for picking
// an index into a small candidate list and keeps us free of node:crypto
// (which can't reach the client bundle anyway — see sim.svelte.ts).
// ----------------------------------------------------------------------------
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pickFrom<T>(candidates: readonly T[], key: string): T {
  const idx = fnv1a(key) % candidates.length;
  // biome-ignore lint/style/noNonNullAssertion: idx is always in range
  return candidates[idx]!;
}

// ----------------------------------------------------------------------------
// Building pools — one per pack. Keep file lists in sync with
// scripts/copy-assets.sh. Files not listed here are still copied to disk but
// simply never referenced; that's fine.
// ----------------------------------------------------------------------------
const SUBURBAN = [
  'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s',
].map((l) => `/models/buildings/suburban/building-type-${l}.glb`);

const COMMERCIAL = [
  'a','b','c','d','e','f','g','h','i','j','k','l','m','n',
].map((l) => `/models/buildings/commercial/building-${l}.glb`);

const COMMERCIAL_SKYSCRAPERS = [
  'a','b','c','d','e',
].map((l) => `/models/buildings/commercial/building-skyscraper-${l}.glb`);

const INDUSTRIAL = [
  'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t',
].map((l) => `/models/buildings/industrial/building-${l}.glb`);

const LOW_DETAIL = [
  'a','b','c','d','e','f','g','h','i','j','k','l','m','n',
].map((l) => `/models/buildings/low-detail/low-detail-building-${l}.glb`);

// variant prefix (before '-') → candidate pool. Prefix matching keeps the
// registry resilient: core can add 'workshop-03' later without touching
// the renderer as long as the prefix is known here.
//
// Prefixes not listed fall through to the 'unknown' pool.
const BUILDING_POOL_BY_PREFIX: Record<string, readonly string[]> = {
  // Primary contract with world-gen (volume-unlocked kits).
  suburban: SUBURBAN,
  commercial: [...COMMERCIAL, ...COMMERCIAL_SKYSCRAPERS],
  industrial: INDUSTRIAL,

  // Legacy prefixes — retained so worlds generated before the kit refactor
  // still render. Semantic-driven naming is deprecated; new variants always
  // use a kit prefix.
  workshop: SUBURBAN,
  clinic: INDUSTRIAL,
  repair: INDUSTRIAL,
  hall: [...COMMERCIAL, ...COMMERCIAL_SKYSCRAPERS],
  library: SUBURBAN,
  archive: SUBURBAN,
  tower: INDUSTRIAL,
  storage: LOW_DETAIL,
  house: SUBURBAN,
};

export function buildingModel(obj: WorldObject): string {
  const prefix = obj.variant.split('-')[0] ?? 'house';
  const pool = BUILDING_POOL_BY_PREFIX[prefix] ?? SUBURBAN;
  return pickFrom(pool, `${obj.commitSha}:${obj.variant}`);
}

// ----------------------------------------------------------------------------
// Decor: tier-C and tier-D. Variants come from world-gen's DECOR_C/DECOR_D
// tables — prefixes: tree, bush, lamp, rock, crate, grass, flower, pebbles.
// ----------------------------------------------------------------------------
const TREES = [
  'tree_oak','tree_default','tree_detailed','tree_fat',
  'tree_pineDefaultA','tree_pineDefaultB','tree_pineRoundA','tree_pineRoundC',
].map((n) => `/models/nature/${n}.glb`);

const BUSHES = [
  'tree_pineSmallA','tree_pineSmallB','grass_leafsLarge',
].map((n) => `/models/nature/${n}.glb`);

const GRASS_TUFTS = [
  'grass','grass_large','grass_leafs','grass_leafsLarge',
].map((n) => `/models/nature/${n}.glb`);

const FLOWERS = [
  'flower_purpleA','flower_redA','flower_yellowA',
].map((n) => `/models/nature/${n}.glb`);

const ROCKS = [
  'cliff_block_rock','cliff_rock',
].map((n) => `/models/nature/${n}.glb`);

const LAMPS = [
  '/models/roads/light-square.glb',
  '/models/roads/light-curved.glb',
  '/models/props/graveyard/lightpost-single.glb',
  '/models/props/fantasy/lantern.glb',
];

const CRATES = [
  '/models/props/car/box.glb',
  '/models/props/car/cone.glb',
];

// City Kit Roads construction sub-kit — barrier / cone / light props that
// mark work-in-progress commits (future: open pull requests) as small
// construction sites scattered among the regular districts.
const CONSTRUCTION = [
  '/models/props/construction/construction-barrier.glb',
  '/models/props/construction/construction-cone.glb',
  '/models/props/construction/construction-light.glb',
];

// Graveyard Kit — tombstones, crosses, coffins. Used by the memorial
// district for revert commits (and closed-unmerged PRs once the ingestion
// pipeline supplies them).
const GRAVES = [
  '/models/props/graveyard/gravestone-bevel.glb',
  '/models/props/graveyard/gravestone-broken.glb',
  '/models/props/graveyard/gravestone-cross.glb',
  '/models/props/graveyard/gravestone-cross-large.glb',
  '/models/props/graveyard/gravestone-debris.glb',
  '/models/props/graveyard/gravestone-decorative.glb',
  '/models/props/graveyard/gravestone-round.glb',
  '/models/props/graveyard/gravestone-wide.glb',
  '/models/props/graveyard/gravestone-roof.glb',
  '/models/props/graveyard/grave.glb',
  '/models/props/graveyard/grave-border.glb',
  '/models/props/graveyard/coffin.glb',
  '/models/props/graveyard/cross-wood.glb',
];

export interface DecorModel {
  path: string;
  // Suggested Y offset in world units — some assets (tufts, flowers) sit
  // flush with the ground; others (lamps, trees) need no offset because
  // their origin is at the base.
  yOffset: number;
  // Uniform scale — Kenney packs ship at varying scales; these values
  // were eyeballed to sit right on our TILE_SIZE=1 grid.
  scale: number;
}

export function decorModel(obj: WorldObject): DecorModel | null {
  const prefix = obj.variant.split('-')[0] ?? '';
  const key = `${obj.commitSha}:${obj.variant}`;
  switch (prefix) {
    case 'tree':
      return { path: pickFrom(TREES, key), yOffset: 0, scale: 0.6 };
    case 'bush':
      return { path: pickFrom(BUSHES, key), yOffset: 0, scale: 0.55 };
    case 'grass':
      return { path: pickFrom(GRASS_TUFTS, key), yOffset: 0, scale: 0.8 };
    case 'flower':
      return { path: pickFrom(FLOWERS, key), yOffset: 0, scale: 0.9 };
    case 'pebbles':
      return { path: pickFrom(ROCKS, key), yOffset: 0, scale: 0.25 };
    case 'rock':
      return { path: pickFrom(ROCKS, key), yOffset: 0, scale: 0.45 };
    case 'lamp':
      return { path: pickFrom(LAMPS, key), yOffset: 0, scale: 0.5 };
    case 'crate':
      return { path: pickFrom(CRATES, key), yOffset: 0, scale: 0.4 };
    case 'grave':
      return { path: pickFrom(GRAVES, key), yOffset: 0, scale: 0.7 };
    case 'construction':
      return { path: pickFrom(CONSTRUCTION, key), yOffset: 0, scale: 0.55 };
    default:
      return null;
  }
}

// ----------------------------------------------------------------------------
// Scenery props — road-side trees the layout planner plants. SceneryProp.id
// is stable ('tree-x-y') so we hash that to keep the species consistent
// across renders.
// ----------------------------------------------------------------------------
const GRASS_TUFT_POOL = [
  '/models/nature/grass.glb',
  '/models/nature/grass_large.glb',
  '/models/nature/grass_leafs.glb',
  '/models/nature/grass_leafsLarge.glb',
];

const FLOWER_POOL = [
  '/models/nature/flower_purpleA.glb',
  '/models/nature/flower_redA.glb',
  '/models/nature/flower_yellowA.glb',
];

// Graveyard corner markers — cross-column pillar on each bbox corner.
const CROSS_COLUMN_PATH = '/models/props/graveyard/cross-column.glb';

export function sceneryModel(prop: SceneryProp): DecorModel {
  if (prop.variant === 'cross-column') {
    return { path: CROSS_COLUMN_PATH, yOffset: 0, scale: 1 };
  }
  const prefix = prop.variant.split('-')[0] ?? 'tree';
  switch (prefix) {
    case 'grass':
      // grass-tuft / grass-tuft-large / grass-leafs all draw from the same
      // Kenney grass pool; variant subtype is cosmetic noise so the field
      // doesn't read as a regular tiling.
      return { path: pickFrom(GRASS_TUFT_POOL, prop.id), yOffset: 0, scale: 0.7 };
    case 'flower':
      return { path: pickFrom(FLOWER_POOL, prop.id), yOffset: 0, scale: 0.8 };
    case 'tree':
    default:
      return { path: pickFrom(TREES, prop.id), yOffset: 0, scale: 0.55 };
  }
}

// ----------------------------------------------------------------------------
// Agents — Mini Characters, male + female variants a..f. Unlike Blocky
// Characters each model shares one colormap.png, so we don't need per-file
// texture hookups.
// ----------------------------------------------------------------------------
const CHARACTERS = (['female', 'male'] as const).flatMap((sex) =>
  ['a','b','c','d','e','f'].map((l) => `/models/characters/character-${sex}-${l}.glb`),
);

const GHOST_PATH = '/models/props/graveyard/character-ghost.glb';

export function agentModel(agent: Agent): string {
  if (agent.role === 'ghost') return GHOST_PATH;
  return pickFrom(CHARACTERS, agent.id);
}

// ----------------------------------------------------------------------------
// Road tiles — picked in Roads.svelte based on 4-neighbor mask, not here.
// Exported as a constant path map so the component has a single source.
// ----------------------------------------------------------------------------
export const ROAD_MODELS = {
  straight: '/models/roads/road-straight.glb',
  bend: '/models/roads/road-bend.glb',
  intersection: '/models/roads/road-intersection.glb', // 3-way T
  crossroad: '/models/roads/road-crossroad.glb',       // 4-way
  end: '/models/roads/road-end.glb',
  square: '/models/roads/road-square.glb',             // isolated tile
} as const;
