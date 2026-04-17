// ============================================================================
// Asset registry — maps abstract variant keys produced by @gitcolony/core
// onto concrete GLB paths served from /static/models.
//
// The variant strings are contract surface between the generator and the
// renderer. Picking is deterministic: for a given variant we always
// resolve to the same GLB path.
//
// Visual source: Kenney's Starter Kit City Builder + City Kit Suburban +
// City Kit Commercial. Each kit ships its own colormap.png; the sibling
// Textures/ folder next to each GLB directory under /static/models is
// installed by scripts/copy-assets.sh.
// ============================================================================

import type { WorldObject, Agent, SceneryProp } from '@gitcolony/schema';

// ----------------------------------------------------------------------------
// Deterministic, non-cryptographic hash for stable per-instance picks when
// the variant key alone isn't enough. FNV-1a 32-bit, no node:crypto.
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
// Buildings — five density tiers, one subdirectory per tier. Variant keys
// come in as `<prefix>-<letter>`, e.g. `floor-1-a`, `skyscraper-c`. Unknown
// prefixes fall back to a deterministic rural pick so legacy worlds still
// render something.
// ----------------------------------------------------------------------------

const BUILDING_DIR = {
  rural: '/models/buildings/rural',
  'floor-1': '/models/buildings/floor-1',
  'floor-2': '/models/buildings/floor-2',
  'floor-3': '/models/buildings/floor-3',
  skyscraper: '/models/buildings/skyscraper',
} as const;

type BuildingPrefix = keyof typeof BUILDING_DIR;

// Per-tier pool, ordered to match the letters assigned by world-gen.
// Consumers pass in `rural-a`, `floor-1-c`, etc.; we look up the tier
// here and drop the letter onto the right filename.
const BUILDING_FILENAMES: Readonly<Record<BuildingPrefix, readonly string[]>> = {
  // starter kit: `building-garage` + `building-small-a..d`. Emit as a/b/c/d/e.
  rural: [
    'building-garage',
    'building-small-a',
    'building-small-b',
    'building-small-c',
    'building-small-d',
  ],
  // suburban a..j (shortest half of the pack)
  'floor-1': 'abcdefghij'.split('').map((l) => `building-type-${l}`),
  // suburban k..u (taller half)
  'floor-2': 'abcdefghijk'.split('').map((_, i) =>
    `building-type-${'klmnopqrstu'.charAt(i)}`,
  ),
  // commercial mid-rise a..n
  'floor-3': 'abcdefghijklmn'.split('').map((l) => `building-${l}`),
  // commercial skyscraper a..e
  skyscraper: 'abcde'.split('').map((l) => `building-skyscraper-${l}`),
};

function parsePrefix(variant: string): { prefix: BuildingPrefix; letter: string } | null {
  // `floor-1-a` has two hyphens inside the prefix — match the longest
  // known prefix first so we don't mis-split.
  for (const prefix of Object.keys(BUILDING_DIR) as BuildingPrefix[]) {
    if (variant === prefix) return { prefix, letter: 'a' };
    if (variant.startsWith(`${prefix}-`)) {
      return { prefix, letter: variant.slice(prefix.length + 1) };
    }
  }
  return null;
}

export function buildingModel(obj: WorldObject): string {
  const parsed = parsePrefix(obj.variant);
  if (!parsed) {
    // Legacy / unknown: deterministic rural pick so the scene still renders.
    const pool = BUILDING_FILENAMES.rural;
    return `${BUILDING_DIR.rural}/${pickFrom(pool, obj.variant)}.glb`;
  }
  const pool = BUILDING_FILENAMES[parsed.prefix];
  const letterIdx = parsed.letter.charCodeAt(0) - 'a'.charCodeAt(0);
  const name =
    letterIdx >= 0 && letterIdx < pool.length
      ? pool[letterIdx]!
      : pool[fnv1a(obj.variant) % pool.length]!;
  return `${BUILDING_DIR[parsed.prefix]}/${name}.glb`;
}

// ----------------------------------------------------------------------------
// Decor / infill — the district planner emits one scenery tile per infill
// slot. Variant strings map 1:1 to the right GLB.
//
// Variants emitted by the new generator:
//   - 'pavement'            → plain pavement square (between buildings)
//   - 'pavement-fountain'   → pavement with a central fountain (plaza)
//   - 'grass'               → bare grass pad (forest)
//   - 'grass-trees'         → grass with small trees (forest)
//   - 'grass-trees-tall'    → grass with tall trees (forest)
// ----------------------------------------------------------------------------

export interface DecorModel {
  path: string;
  // Y offset in world units — starter-kit tiles all sit flush at Y=0.
  yOffset: number;
  // Uniform scale. Starter-kit tiles are 1 unit per tile; TILE_SIZE is 1.
  scale: number;
}

const PAVEMENT_PATH = '/models/pavement/pavement.glb';
const FOUNTAIN_PATH = '/models/pavement/pavement-fountain.glb';
const GRASS_PATH = '/models/nature/grass.glb';
const GRASS_TREES_PATH = '/models/nature/grass-trees.glb';
const GRASS_TREES_TALL_PATH = '/models/nature/grass-trees-tall.glb';

function decorFor(variant: string): DecorModel | null {
  switch (variant) {
    case 'pavement':
      return { path: PAVEMENT_PATH, yOffset: 0, scale: 1 };
    case 'pavement-fountain':
    case 'fountain':
      return { path: FOUNTAIN_PATH, yOffset: 0, scale: 1 };
    case 'grass':
      return { path: GRASS_PATH, yOffset: 0, scale: 1 };
    case 'grass-trees':
    case 'tree':
      return { path: GRASS_TREES_PATH, yOffset: 0, scale: 1 };
    case 'grass-trees-tall':
    case 'tree-tall':
      return { path: GRASS_TREES_TALL_PATH, yOffset: 0, scale: 1 };
    default:
      return null;
  }
}

export function decorModel(obj: WorldObject): DecorModel | null {
  return decorFor(obj.variant);
}

export function sceneryModel(prop: SceneryProp): DecorModel {
  // Unknown scenery variants fall back to a bare grass tile so retired
  // variant strings still render.
  return decorFor(prop.variant) ?? { path: GRASS_PATH, yOffset: 0, scale: 1 };
}

// ----------------------------------------------------------------------------
// Agents — Mini Characters, male + female variants a..f. The starter kit
// ships no characters, so this external pack stays.
// ----------------------------------------------------------------------------
const CHARACTERS = (['female', 'male'] as const).flatMap((sex) =>
  ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => `/models/characters/character-${sex}-${l}.glb`),
);

export function agentModel(agent: Agent): string {
  return pickFrom(CHARACTERS, agent.id);
}

// ----------------------------------------------------------------------------
// Road tiles — picked in Roads.svelte based on 4-neighbor mask. Sourced
// from Kenney's Starter Kit City Builder pack.
// ----------------------------------------------------------------------------
export const ROAD_MODELS = {
  straight: '/models/roads/road-straight.glb',
  straightLit: '/models/roads/road-straight-lightposts.glb',
  corner: '/models/roads/road-corner.glb',
  split: '/models/roads/road-intersection.glb',
  intersection: '/models/roads/road-split.glb',
  deadEnd: '/models/pavement/pavement-fountain.glb',
} as const;
