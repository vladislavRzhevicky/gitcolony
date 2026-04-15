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
  // semanticType 'feat' produces workshop-* and house-* (house is the generic
  // residential fallback). Both get the suburban pool.
  workshop: SUBURBAN,
  // semanticType 'fix' → industrial look (factories, repair yards).
  clinic: INDUSTRIAL,
  repair: INDUSTRIAL,
  // semanticType 'refactor' → commercial halls / skyscrapers. Mix both so
  // refactor-heavy repos grow downtowns rather than a wall of identical halls.
  hall: [...COMMERCIAL, ...COMMERCIAL_SKYSCRAPERS],
  // semanticType 'docs' → cozier suburban buildings.
  library: SUBURBAN,
  archive: SUBURBAN,
  // semanticType 'test' → industrial plants / tanks.
  tower: INDUSTRIAL,
  // semanticType 'chore' → background / low-detail row.
  storage: LOW_DETAIL,
  // 'unknown' fallback in world-gen picks 'house-*'.
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
    default:
      return null;
  }
}

// ----------------------------------------------------------------------------
// Scenery props — road-side trees the layout planner plants. SceneryProp.id
// is stable ('tree-x-y') so we hash that to keep the species consistent
// across renders.
// ----------------------------------------------------------------------------
export function sceneryModel(prop: SceneryProp): DecorModel {
  return { path: pickFrom(TREES, prop.id), yOffset: 0, scale: 0.55 };
}

// ----------------------------------------------------------------------------
// Agents — Mini Characters, male + female variants a..f. Unlike Blocky
// Characters each model shares one colormap.png, so we don't need per-file
// texture hookups.
// ----------------------------------------------------------------------------
const CHARACTERS = (['female', 'male'] as const).flatMap((sex) =>
  ['a','b','c','d','e','f'].map((l) => `/models/characters/character-${sex}-${l}.glb`),
);

export function agentModel(agent: Agent): string {
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
