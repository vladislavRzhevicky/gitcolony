import type { District, TilePos } from '@gitcolony/schema';
import { type GridMask, type GridSize, getBit, inBounds } from './grid.js';

// ============================================================================
// Road routing — deterministic A* over the walkable mask between district
// centers. Roads themselves are visual-only (they don't block movement) but
// are frozen into the World alongside districts so the renderer and sim can
// both consume the same paths.
//
// Pairing strategy (MVP, per docs/layout-districts.md §5):
//   - every non-outskirts district connects to its 1-nearest non-outskirts
//     neighbor by euclidean distance (ties broken by district id);
//   - every non-outskirts district connects to the outskirts district.
// Outskirts guarantees the graph is connected without requiring full MST.
// ============================================================================

// 4-neighbor order fixes deterministic expansion. Matches "by (y, x, dir)"
// tie-breaking in the round spec: N has the smallest y, W the largest x, etc.
const DIRS: readonly { dx: number; dy: number }[] = [
  { dx: 0, dy: -1 }, // 0 = N
  { dx: 1, dy: 0 },  // 1 = E
  { dx: 0, dy: 1 },  // 2 = S
  { dx: -1, dy: 0 }, // 3 = W
];

const NO_DIR = 4;
const TURN_PENALTY = 0.5;
// Cost multiplier for stepping onto a non-road walkable tile when a road
// mask is supplied. 1.0 = no preference; values >1 bias the planner
// toward road tiles without making diagonals-through-grass unreachable.
// Tuned so agents will still cut across a pad to save 3+ tiles, but will
// prefer the street for any shorter detour.
const OFFROAD_COST = 1.4;

// Pack (x, y, dir) into a single number. Safe for grids up to 10000x10000.
function encode(x: number, y: number, dir: number): number {
  return (y * 10000 + x) * 8 + dir;
}

interface OpenNode {
  f: number;
  g: number;
  x: number;
  y: number;
  dir: number;
}

// ----------------------------------------------------------------------------
// A*: shortest path from start to goal on `occupied` (1 = blocked).
// Returns the path as a contiguous tile sequence including start and goal,
// or null if unreachable.
//
// - Heuristic: manhattan distance (admissible on 4-neighbor grid).
// - Step cost: 1, plus TURN_PENALTY when direction changes — biases roads
//   toward straighter runs without making them suboptimal in length.
// - Occupancy: blocked tiles cannot be entered. The goal tile is allowed
//   even if blocked (so a road can reach a district center that happens to
//   have an object on it); start is implicit and not re-checked.
// - Tie-breaking: open-set pick is strictly ordered on (f, y, x, dir), so
//   the same input always yields the same path.
// ----------------------------------------------------------------------------
export function aStar(
  occupied: GridMask,
  start: TilePos,
  goal: TilePos,
  roadMask?: GridMask,
): TilePos[] | null {
  if (!inBounds(occupied, start.x, start.y)) return null;
  if (!inBounds(occupied, goal.x, goal.y)) return null;

  const open: OpenNode[] = [];
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();

  const h0 = Math.abs(start.x - goal.x) + Math.abs(start.y - goal.y);
  const startKey = encode(start.x, start.y, NO_DIR);
  gScore.set(startKey, 0);
  open.push({ f: h0, g: 0, x: start.x, y: start.y, dir: NO_DIR });

  while (open.length > 0) {
    // Linear scan pick. Grids are small (≤ a few thousand tiles); a binary
    // heap would be measurable only at much larger scales, and ordered scan
    // keeps tie-breaking explicit and auditable.
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (lessThan(open[i]!, open[bestIdx]!)) bestIdx = i;
    }
    const cur = open.splice(bestIdx, 1)[0]!;
    const curKey = encode(cur.x, cur.y, cur.dir);

    // Skip stale entries whose g was later improved.
    if ((gScore.get(curKey) ?? Infinity) < cur.g) continue;

    if (cur.x === goal.x && cur.y === goal.y) {
      return reconstruct(cameFrom, curKey);
    }

    for (let d = 0; d < 4; d++) {
      const nx = cur.x + DIRS[d]!.dx;
      const ny = cur.y + DIRS[d]!.dy;
      if (!inBounds(occupied, nx, ny)) continue;
      const isGoal = nx === goal.x && ny === goal.y;
      if (!isGoal && getBit(occupied, nx, ny) === 1) continue;

      const turn = cur.dir !== NO_DIR && cur.dir !== d ? TURN_PENALTY : 0;
      const stepBase = roadMask && getBit(roadMask, nx, ny) === 1 ? 1 : OFFROAD_COST;
      // Road tiles cost exactly 1 when a mask is supplied so the heuristic
      // stays admissible (manhattan ≤ true cost). When no roadMask is
      // given we fall back to flat cost 1 — preserves the original
      // planRoads semantics where roads are computed before any mask exists.
      const newG = cur.g + (roadMask ? stepBase : 1) + turn;
      const nKey = encode(nx, ny, d);
      if (newG < (gScore.get(nKey) ?? Infinity)) {
        gScore.set(nKey, newG);
        cameFrom.set(nKey, curKey);
        const h = Math.abs(nx - goal.x) + Math.abs(ny - goal.y);
        open.push({ f: newG + h, g: newG, x: nx, y: ny, dir: d });
      }
    }
  }

  return null;
}

function lessThan(a: OpenNode, b: OpenNode): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.y !== b.y) return a.y < b.y;
  if (a.x !== b.x) return a.x < b.x;
  return a.dir < b.dir;
}

function reconstruct(
  cameFrom: Map<number, number>,
  endKey: number,
): TilePos[] {
  const path: TilePos[] = [];
  let k: number | undefined = endKey;
  while (k !== undefined) {
    const dir = k % 8;
    const rest = (k - dir) / 8;
    const x = rest % 10000;
    const y = (rest - x) / 10000;
    path.push({ x, y });
    k = cameFrom.get(k);
  }
  path.reverse();
  return path;
}

// ----------------------------------------------------------------------------
// Public: plan the road network for a set of districts.
//
// `rng` is accepted for signature symmetry with other world-gen steps but is
// not consumed — pairing and A* are both fully deterministic given the input
// districts and mask. Same inputs → same output.
// ----------------------------------------------------------------------------

export interface PlanRoadsInput {
  districts: readonly District[];
  occupied: GridMask;
  grid: GridSize;
  rng: () => number;
}

export function planRoads({
  districts,
  occupied,
}: PlanRoadsInput): TilePos[][] {
  const outskirts = districts.find((d) => d.isOutskirts);
  const nonOutskirts = districts.filter((d) => !d.isOutskirts);
  if (nonOutskirts.length === 0) return [];

  const pairs = new Set<string>();
  const pairKey = (a: District, b: District): string =>
    a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;

  // 1-nearest non-outskirts neighbor per district (euclidean², ties by id).
  const sortedDistricts = [...nonOutskirts].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const a of sortedDistricts) {
    let best: District | null = null;
    let bestD = Infinity;
    for (const b of sortedDistricts) {
      if (b.id === a.id) continue;
      const dx = a.center.x - b.center.x;
      const dy = a.center.y - b.center.y;
      const dsq = dx * dx + dy * dy;
      if (dsq < bestD || (dsq === bestD && best !== null && b.id < best.id)) {
        bestD = dsq;
        best = b;
      }
    }
    if (best) pairs.add(pairKey(a, best));
  }

  // Connect every non-outskirts district to outskirts — guarantees connectivity.
  if (outskirts) {
    for (const a of sortedDistricts) pairs.add(pairKey(a, outskirts));
  }

  const byId = new Map(districts.map((d) => [d.id, d]));
  const roads: TilePos[][] = [];
  for (const key of Array.from(pairs).sort()) {
    const [aId, bId] = key.split('|');
    const a = byId.get(aId!);
    const b = byId.get(bId!);
    if (!a || !b) continue;
    const path = aStar(occupied, a.center, b.center);
    if (path) roads.push(path);
  }
  return roads;
}
