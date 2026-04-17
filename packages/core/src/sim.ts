import type { Agent, TilePos, World, WorldObject } from '@gitcolony/schema';
import {
  type GridMask,
  buildOccupiedMask,
  createMask,
  districtBBox,
  getBit,
  inBounds,
  setBit,
} from './grid.js';
import { aStar } from './roads.js';
// Pulled from rng.js (not seed.js) so the client bundle doesn't transitively
// load `node:crypto` — sim runs in both environments.
import { createRng } from './rng.js';

// ============================================================================
// Agent simulation — pure, deterministic primitives.
//
// The renderer drives a tick loop; per tick each agent advances one tile
// along a pre-planned path. When an agent reaches its target POI it picks
// the next POI (rotated deterministically) and re-plans with A*.
//
// Nothing here is stateful at the module level: the caller owns runtime
// records and passes them back in. That keeps the whole simulation
// reproducible for a given (world, seed) pair.
// ============================================================================

/**
 * Blocked-tile mask consumed by A* (1 = blocked, 0 = free).
 *
 * Buildings (tier B) and any decor with a footprint block movement.
 * Roads and district pads are flat and don't block. Agent spawn tiles
 * aren't in `objects`, so they stay walkable by construction.
 *
 * Named for the sim pipeline step, not the bit semantics — matches the
 * "walkable surface" language in roadmap docs while delegating to the
 * existing occupancy builder.
 */
export function buildSimWalkable(world: Pick<World, 'grid' | 'objects'>): GridMask {
  return buildOccupiedMask(world.grid, world.objects);
}

/**
 * Road tiles as a bitmask (1 = road, 0 = everything else). Passed to A* so
 * the planner can prefer road tiles over open ground when routing between
 * POIs — agents then visibly walk the streets instead of cutting diagonals
 * across empty district pads.
 */
export function buildRoadMask(world: Pick<World, 'grid' | 'roads'>): GridMask {
  const m = createMask(world.grid);
  for (const path of world.roads) {
    for (const t of path.tiles) setBit(m, t.x, t.y, 1);
  }
  return m;
}

// ----------------------------------------------------------------------------
// Points of interest
// ----------------------------------------------------------------------------

/**
 * POIs per district: one walkable "entrance" tile for each building plus
 * the district center as a fallback. Entrances are the first walkable
 * 4-neighbor of each building footprint, chosen in (y, x) order so the
 * result is stable across runs.
 *
 * Districts with no buildings still get the center so agents there have
 * somewhere to walk to.
 */
export function collectPOIs(
  world: Pick<World, 'districts' | 'objects' | 'grid'>,
  walkable: GridMask,
): Map<string, TilePos[]> {
  const byDistrict = new Map<string, TilePos[]>();
  for (const d of world.districts) {
    byDistrict.set(d.id, []);
  }

  const buildings = world.objects
    .filter((o): o is WorldObject => o.kind === 'building')
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const b of buildings) {
    const entrance = findEntrance(b, walkable);
    if (!entrance) continue;
    const list = byDistrict.get(b.districtId);
    if (list) list.push(entrance);
  }

  // Always include district center as a fallback waypoint. If the center is
  // blocked (a building landed on it) we still include it — A* allows
  // the goal tile to be blocked, and the renderer will read the pos from
  // the path, not the center directly.
  for (const d of world.districts) {
    const list = byDistrict.get(d.id)!;
    list.push({ x: d.center.x, y: d.center.y });
  }

  return byDistrict;
}

/**
 * Walkable tiles inside the graveyard district's bbox — the POI pool for
 * ghost agents, who wander only within the memorial pad. Empty when there
 * is no graveyard district (or the whole pad filled up with graves).
 */
export function collectGraveyardPOIs(
  world: Pick<World, 'districts' | 'grid'>,
  walkable: GridMask,
): TilePos[] {
  const graveyard = world.districts.find((d) => d.isGraveyard);
  if (!graveyard) return [];
  const bbox = districtBBox(graveyard, world.grid);
  const out: TilePos[] = [];
  for (let y = bbox.y0; y <= bbox.y1; y++) {
    for (let x = bbox.x0; x <= bbox.x1; x++) {
      if (!inBounds(walkable, x, y)) continue;
      if (getBit(walkable, x, y) === 1) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/**
 * Walkable mask clipped to the graveyard bbox — everything outside the
 * memorial pad is marked blocked, so A* cannot route ghosts through
 * neighboring districts even when the shortcut would be shorter.
 */
export function buildGraveyardWalkable(
  world: Pick<World, 'districts' | 'grid'>,
  walkable: GridMask,
): GridMask {
  const clipped = createMask(world.grid);
  // Start fully blocked, then punch holes inside the graveyard bbox where
  // the base walkable is also free.
  for (let i = 0; i < clipped.bits.length; i++) clipped.bits[i] = 1;
  const graveyard = world.districts.find((d) => d.isGraveyard);
  if (!graveyard) return clipped;
  const bbox = districtBBox(graveyard, world.grid);
  for (let y = bbox.y0; y <= bbox.y1; y++) {
    for (let x = bbox.x0; x <= bbox.x1; x++) {
      if (!inBounds(walkable, x, y)) continue;
      if (getBit(walkable, x, y) === 1) continue;
      setBit(clipped, x, y, 0);
    }
  }
  return clipped;
}

function findEntrance(obj: WorldObject, walkable: GridMask): TilePos | null {
  // Gather all 4-neighbors of the footprint that are not themselves part of
  // the footprint. Scan in (y, x) order for determinism.
  const fp = new Set(obj.footprint.map((t) => `${t.x},${t.y}`));
  const candidates: TilePos[] = [];
  for (const t of obj.footprint) {
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = t.x + dx;
      const ny = t.y + dy;
      if (fp.has(`${nx},${ny}`)) continue;
      if (!inBounds(walkable, nx, ny)) continue;
      if (getBit(walkable, nx, ny) === 1) continue;
      candidates.push({ x: nx, y: ny });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return candidates[0]!;
}

// ----------------------------------------------------------------------------
// Agent runtime
// ----------------------------------------------------------------------------

/**
 * Per-agent simulation state. `pos` is the tile the agent currently
 * occupies; `path` is the tile sequence from `pos` (exclusive) to the
 * current target POI (inclusive). `poiIndex` rotates through the *global*
 * POI list (every building entrance + every district center in the world)
 * so agents eventually traverse every district — they're citizens of the
 * whole colony, not prisoners of one pad.
 *
 * `districtId` is kept on the runtime for UI / telemetry but no longer
 * constrains movement: an agent can be standing anywhere on the grid at a
 * given tick.
 */
export interface AgentRuntime {
  id: string;
  commitSha: string;
  districtId: string;
  role: string;
  pos: TilePos;
  path: TilePos[];
  poiIndex: number;
  // How many consecutive re-plan attempts have failed. After a few
  // failures we freeze the agent rather than retrying every tick.
  stuckTicks: number;
}

/**
 * Flattens the per-district POI map into a single stable list. Sorted by
 * (y, x) so the rotation order is reproducible from the world state alone
 * — no dependence on Map insertion order or district iteration quirks.
 */
export function flattenPOIs(pois: Map<string, TilePos[]>): TilePos[] {
  const out: TilePos[] = [];
  for (const list of pois.values()) out.push(...list);
  out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  // Dedup identical tiles (a district center can coincide with a building
  // entrance in tightly-packed layouts).
  const seen = new Set<string>();
  return out.filter((t) => {
    const k = `${t.x},${t.y}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Creates a runtime record for each agent. Initial path aims at a POI
 * picked from the global rotation, offset by a hash of the agent id so
 * agents don't all converge on the same tile first.
 */
export function initAgentRuntimes(
  world: Pick<World, 'agents' | 'districts' | 'objects' | 'grid' | 'seed'>,
  walkable: GridMask,
  pois: Map<string, TilePos[]>,
  roadMask?: GridMask,
): AgentRuntime[] {
  const runtimes: AgentRuntime[] = [];
  const globalPois = flattenPOIs(pois);
  for (let i = 0; i < world.agents.length; i++) {
    const a = world.agents[i]!;
    const startIdx = globalPois.length > 0 ? hash32(a.id) % globalPois.length : 0;
    const rt: AgentRuntime = {
      id: a.id,
      commitSha: a.commitSha,
      districtId: a.districtId,
      role: a.role,
      pos: { x: a.spawn.x, y: a.spawn.y },
      path: [],
      poiIndex: startIdx,
      stuckTicks: 0,
    };
    replan(rt, globalPois, walkable, roadMask);
    runtimes.push(rt);
  }
  return runtimes;
}

/**
 * Advances an agent by one tile. If the current path is exhausted, picks
 * the next POI in the global rotation and re-plans. Mutates the runtime
 * in place — callers hold stable references so the scene can read updated
 * positions every frame without allocating.
 */
export function stepAgent(
  rt: AgentRuntime,
  walkable: GridMask,
  pois: TilePos[],
  roadMask?: GridMask,
): void {
  if (rt.path.length === 0) {
    rt.poiIndex = (rt.poiIndex + 1) % Math.max(1, pois.length);
    replan(rt, pois, walkable, roadMask);
    if (rt.path.length === 0) {
      rt.stuckTicks++;
      return;
    }
  }
  const next = rt.path.shift()!;
  rt.pos = next;
  rt.stuckTicks = 0;
}

function replan(
  rt: AgentRuntime,
  poiList: readonly TilePos[],
  walkable: GridMask,
  roadMask?: GridMask,
): void {
  if (poiList.length === 0) {
    rt.path = [];
    return;
  }
  // Try POIs in rotation order until A* returns a path. Caps the attempts
  // at the list length so an unreachable POI pool fails fast.
  for (let attempt = 0; attempt < poiList.length; attempt++) {
    const goal = poiList[(rt.poiIndex + attempt) % poiList.length]!;
    if (goal.x === rt.pos.x && goal.y === rt.pos.y) continue;
    const path = aStar(walkable, rt.pos, goal, roadMask);
    if (path && path.length > 1) {
      // Drop the first entry — it's the current position.
      rt.path = path.slice(1);
      rt.poiIndex = (rt.poiIndex + attempt) % poiList.length;
      return;
    }
  }
  rt.path = [];
}

// Small stable non-crypto hash for deterministic POI offsets. Java's
// String.hashCode reduced to 32 bits — good enough and cheap.
function hash32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// ----------------------------------------------------------------------------
// Convenience: one-shot simulation for tests / screenshots.
//
// Advances the whole colony by `ticks` steps and returns the final runtime
// snapshot. The renderer doesn't call this — it owns its own per-frame
// loop — but tests and future server-side preview generators do.
// ----------------------------------------------------------------------------

export function simulate(
  world: Pick<World, 'agents' | 'districts' | 'objects' | 'grid' | 'seed' | 'roads'>,
  ticks: number,
): AgentRuntime[] {
  const walkable = buildSimWalkable(world);
  const roadMask = buildRoadMask(world);
  const poiMap = collectPOIs(world, walkable);
  const globalPois = flattenPOIs(poiMap);
  const runtimes = initAgentRuntimes(world, walkable, poiMap, roadMask);
  // createRng is currently unused inside the loop — sim is deterministic
  // without consuming RNG — but we touch it once so future additions of
  // jittered step timing stay seed-derived.
  createRng(`${world.seed}:sim`)();
  for (let t = 0; t < ticks; t++) {
    for (const rt of runtimes) stepAgent(rt, walkable, globalPois, roadMask);
  }
  return runtimes;
}

// Re-export the Agent type so consumers don't need two imports.
export type { Agent };

// Re-exported so the web layer can compute custom paths (LLM-directed
// goto / follow intents) without pulling the root barrel, which drags in
// `node:crypto` via `seed.ts`. The `./sim` subpath stays browser-safe.
export { aStar } from './roads.js';
export type { GridMask } from './grid.js';
