import type { World, WorldObject, Agent, TilePos } from '@gitcolony/schema';

// ============================================================================
// World ↔ scene-space helpers.
//
// Grid is (x,y) ∈ [0,w)×[0,h). We render on the XZ plane with the city
// centered at the origin: tile (0,0) maps to the far-negative corner, and
// tile (w,h) to the far-positive corner. One tile = TILE_SIZE world units.
//
// Y in the scene is *up* (height). Do not mix with the grid's y — callers
// should use `tileToWorld(pos)` and never index three.js positions directly.
// ============================================================================

export const TILE_SIZE = 1;

export interface Vec3 { x: number; y: number; z: number; }

export function tileToWorld(pos: TilePos, grid: { w: number; h: number }, y = 0): Vec3 {
  return {
    x: (pos.x - grid.w / 2 + 0.5) * TILE_SIZE,
    y,
    z: (pos.y - grid.h / 2 + 0.5) * TILE_SIZE,
  };
}

// Footprint → a centered position + (width, depth) in world units. Used to
// size tier-B boxes so they span all their footprint tiles rather than
// sitting as a 1x1 cube on the anchor.
export function footprintBounds(obj: WorldObject, grid: { w: number; h: number }) {
  const xs = obj.footprint.map((t) => t.x);
  const zs = obj.footprint.map((t) => t.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return {
    center: tileToWorld({ x: cx, y: cz }, grid, 0),
    width: (maxX - minX + 1) * TILE_SIZE,
    depth: (maxZ - minZ + 1) * TILE_SIZE,
  };
}

// ============================================================================
// Ground palette. Since the scene moved to Kenney GLB assets, per-object
// colors live inside the imported materials — the only colors the renderer
// still paints itself are the base ground/meadow and the district pads.
// ============================================================================

export const COLORS = {
  // `ground` is sampled from the Kenney Hexagon Kit colormap so the city
  // platform plane blends seamlessly with grass hex tiles around it —
  // without this match the platform reads as a raised podium of a
  // different shade. `districtGround` / `outskirtsGround` are subtly
  // tinted variants so districts still read as zones but don't punch
  // out of the unified green base — delta ≈ 3–5 per channel is enough
  // to catch the eye at road edges without feeling like separate decks.
  ground: '#4f896a',
  groundDark: '#3f5a2c', // retained for legacy; currently unused, safe to remove later.
  districtGround: '#528d6e',
  outskirtsGround: '#4b8566',
  // Graveyard district pad — cooler, desaturated so tombstones read
  // against it and the memorial quarter feels distinct from living land.
  graveyardGround: '#4a5560',
} as const;

// Picked selection — uniform shape so the page-level handler doesn't care
// whether the click landed on a building, decor, or agent.
export type PickedKind = 'object' | 'agent';
export interface Picked {
  kind: PickedKind;
  id: string;
  commitSha: string;
  message?: string;
  authorLogin?: string | null;
  authoredAt?: string;
  districtId: string;
  // LLM-authored display fields. `tagline` only ever set on objects,
  // `personality` only on agents — kept on the same shape to keep the
  // CommitPanel single-discriminant.
  displayName?: string | null;
  tagline?: string | null;
  personality?: string | null;
}

export function pickedFromObject(o: WorldObject): Picked {
  return {
    kind: 'object',
    id: o.id,
    commitSha: o.commitSha,
    message: o.message,
    authorLogin: o.authorLogin ?? null,
    authoredAt: o.authoredAt,
    districtId: o.districtId,
    displayName: o.displayName ?? null,
    tagline: o.tagline ?? null,
  };
}

export function pickedFromAgent(a: Agent): Picked {
  return {
    kind: 'agent',
    id: a.id,
    commitSha: a.commitSha,
    message: a.message,
    authorLogin: a.authorLogin ?? null,
    authoredAt: a.authoredAt,
    districtId: a.districtId,
    displayName: a.displayName ?? null,
    personality: a.personality ?? null,
  };
}

// Re-export the World type for convenience so scene components import
// everything from this module.
export type { World, WorldObject, Agent };
