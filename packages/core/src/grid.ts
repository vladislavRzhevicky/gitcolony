import type { District, TilePos, WorldObject } from '@gitcolony/schema';

// ============================================================================
// Grid primitives — tile masks and collision-resolved placement.
//
// Pure, deterministic, no I/O. Used by world-gen for placement and (later) by
// sim for pathfinding. The mask is the single source of truth for "which tile
// is free"; both consumers read the same structure.
// ============================================================================

export interface GridSize {
  w: number;
  h: number;
}

export interface GridMask {
  w: number;
  h: number;
  /** Row-major, 1 = occupied (or blocked), 0 = free. */
  bits: Uint8Array;
}

export function createMask({ w, h }: GridSize): GridMask {
  return { w, h, bits: new Uint8Array(w * h) };
}

export function inBounds(m: GridMask, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < m.w && y < m.h;
}

export function getBit(m: GridMask, x: number, y: number): 0 | 1 {
  if (!inBounds(m, x, y)) return 1; // treat out-of-grid as blocked
  return (m.bits[y * m.w + x] ?? 0) === 0 ? 0 : 1;
}

export function setBit(m: GridMask, x: number, y: number, value: 0 | 1): void {
  if (!inBounds(m, x, y)) return;
  m.bits[y * m.w + x] = value;
}

// ----------------------------------------------------------------------------
// Footprint shapes
// ----------------------------------------------------------------------------

/**
 * Relative tile offsets from an object's anchor. Anchor itself is (0,0).
 * MVP shapes: all rectangles. Easy to expand later.
 */
export type FootprintShape = readonly TilePos[];

export const FOOTPRINT_BUILDING_2x1: FootprintShape = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
];

export const FOOTPRINT_DECOR_1x1: FootprintShape = [{ x: 0, y: 0 }];

export function absoluteFootprint(
  anchor: TilePos,
  shape: FootprintShape,
): TilePos[] {
  return shape.map((o) => ({ x: anchor.x + o.x, y: anchor.y + o.y }));
}

// ----------------------------------------------------------------------------
// Occupancy checks
// ----------------------------------------------------------------------------

export function isFootprintFree(m: GridMask, tiles: readonly TilePos[]): boolean {
  for (const t of tiles) {
    if (!inBounds(m, t.x, t.y)) return false;
    if (getBit(m, t.x, t.y) === 1) return false;
  }
  return true;
}

export function markFootprint(
  m: GridMask,
  tiles: readonly TilePos[],
  value: 0 | 1,
): void {
  for (const t of tiles) setBit(m, t.x, t.y, value);
}

// ----------------------------------------------------------------------------
// District bounding box
// ----------------------------------------------------------------------------

export interface BBox {
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number; // inclusive
}

export function districtBBox(d: District, grid: GridSize): BBox {
  const hw = Math.floor(d.sizeInTiles.w / 2);
  const hh = Math.floor(d.sizeInTiles.h / 2);
  return {
    x0: Math.max(0, d.center.x - hw),
    y0: Math.max(0, d.center.y - hh),
    x1: Math.min(grid.w - 1, d.center.x - hw + d.sizeInTiles.w - 1),
    y1: Math.min(grid.h - 1, d.center.y - hh + d.sizeInTiles.h - 1),
  };
}

// ----------------------------------------------------------------------------
// Placement search
//
// Strategy: seeded starting point inside the bbox; linear scan over a shuffled
// tile list. "Shuffled" is derived from the provided RNG so the same seed
// always produces the same placement order. This is simpler and more robust
// than a spiral and touches every candidate exactly once.
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------

/**
 * Returns an anchor whose footprint fits entirely inside `bbox` and does not
 * intersect occupied tiles in `mask`. Returns null if no such anchor exists.
 *
 * Deterministic for a given `rng` state.
 */
export function findPlacement(
  mask: GridMask,
  bbox: BBox,
  shape: FootprintShape,
  rng: () => number,
): TilePos | null {
  // Compute the anchor-bbox: positions where shape fully fits inside bbox.
  const maxDx = shape.reduce((m, t) => Math.max(m, t.x), 0);
  const maxDy = shape.reduce((m, t) => Math.max(m, t.y), 0);
  const minDx = shape.reduce((m, t) => Math.min(m, t.x), 0);
  const minDy = shape.reduce((m, t) => Math.min(m, t.y), 0);

  const ax0 = bbox.x0 - minDx;
  const ay0 = bbox.y0 - minDy;
  const ax1 = bbox.x1 - maxDx;
  const ay1 = bbox.y1 - maxDy;

  if (ax0 > ax1 || ay0 > ay1) return null;

  const width = ax1 - ax0 + 1;
  const height = ay1 - ay0 + 1;
  const total = width * height;

  // Fisher-Yates over indices, stopping as soon as we find a fit.
  const indices = new Uint32Array(total);
  for (let i = 0; i < total; i++) indices[i] = i;
  for (let i = total - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = indices[i]!;
    indices[i] = indices[j]!;
    indices[j] = tmp;
  }

  for (let k = 0; k < total; k++) {
    const idx = indices[k]!;
    const ax = ax0 + (idx % width);
    const ay = ay0 + Math.floor(idx / width);
    const tiles = absoluteFootprint({ x: ax, y: ay }, shape);
    if (isFootprintFree(mask, tiles)) return { x: ax, y: ay };
  }
  return null;
}

// ----------------------------------------------------------------------------
// World-level masks
// ----------------------------------------------------------------------------

/**
 * Builds an occupancy mask from an existing object set.
 * Used by extendWorld to avoid stomping on previously placed objects.
 */
export function buildOccupiedMask(
  grid: GridSize,
  objects: readonly WorldObject[],
): GridMask {
  const mask = createMask(grid);
  for (const o of objects) {
    markFootprint(mask, o.footprint, 1);
  }
  return mask;
}

/**
 * Walkable mask = inverse of occupied. Consumed by sim/pathfinding.
 * Future additions (blocked terrain, water) will XOR in here.
 */
export function buildWalkableMask(
  grid: GridSize,
  objects: readonly WorldObject[],
): GridMask {
  const occ = buildOccupiedMask(grid, objects);
  const out = createMask(grid);
  for (let i = 0; i < out.bits.length; i++) {
    out.bits[i] = occ.bits[i] === 1 ? 0 : 1;
  }
  return out;
}
