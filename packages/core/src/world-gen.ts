import type {
  Agent,
  District,
  RankedCommit,
  RepoData,
  SceneryProp,
  TilePos,
  World,
  WorldObject,
  WorldStats,
} from '@gitcolony/schema';
import { createRng, deriveSeed } from './seed.js';
import {
  type FootprintShape,
  type GridMask,
  buildOccupiedMask,
  createMask,
  setBit,
} from './grid.js';
import {
  type HouseCategory,
  type HouseCounts,
  DEFAULT_HOUSE_CAP,
  computeHouseCounts,
  totalHouses,
} from './houseCounts.js';
import {
  type DistrictPlan,
  type PlannedDistrict,
  pickResidentialShapes,
  planDistricts,
} from './districtPlan.js';

// ============================================================================
// World generator — aggregated housing model.
//
// The old pipeline was 1:1 commit ↔ object, which collapsed on 30k+ repos
// (browser froze on render). This module replaces that with an aggregated
// model: C (commit count) drives a small, fixed set of house categories,
// each laid out into districts of known shapes with a road ring. Commits
// no longer carry into the scene as individual buildings — a top-N subset
// is still attached to houses as "representative" commits so the side
// panel and LLM naming have something to read, and tier-A commits still
// spawn wandering agents.
//
// Invariants (see CLAUDE.md / schema comments):
//   1. Deterministic seed — unchanged, `deriveSeed(repoFullName)` still
//      the stable entry point.
//   2. Layout immutability — district count/shape depends only on C and
//      the cap, both stable on sync; `extendWorld` never re-plans.
//   3. Outskirts fallback — a 1×1 `d-outskirts` district is always
//      present outside the populated city area. It holds nothing in
//      steady state but satisfies downstream consumers that filter on
//      `isOutskirts`.
//   4. Stable object ids — now `obj-h-<districtId>-<slotIdx>` (seeded
//      by the stable district plan); `agent-<sha>` unchanged.
// ============================================================================

// Fountain scaling: 1 plaza for villages, +1 per 10k commits, max 3. Keeps
// small cities from looking plaza-heavy against a handful of residentials.
const FOUNTAIN_BASE = 1;
const FOUNTAIN_PER_10K = 1;
const MAX_FOUNTAINS = 3;

// Forest share: per spec, base 0.18 + up to +0.10 growth with log10(C+1).
// Capped at 35% of total districts and gated by a residential minimum so
// small villages don't end up as forests with a lone hut.
const FOREST_SHARE_BASE = 0.18;
const FOREST_SHARE_GROWTH_MAX = 0.10;
const FOREST_SHARE_GROWTH_RATE = 0.02;
const FOREST_MAX_SHARE = 0.35;
const RESIDENTIAL_MIN_SHARE = 0.55;

// Budget for roaming tier-A agents. The new model doesn't scale with
// commit count (that's what the house cap is for); it's a small fixed
// pool so the sim has something to animate without drowning the frame.
// Base raised from 8 → 12 after feedback that small colonies felt empty.
const AGENT_BUDGET_BASE = 12;
const AGENT_BUDGET_MAX = 32;

// Small, stable id suffix for synthetic buildings — one per slot per
// district. Keeps ids short and human-readable.
function objectId(districtId: string, slotIdx: number): string {
  return `obj-h-${districtId}-${slotIdx}`;
}

// ----------------------------------------------------------------------------
// Policy knobs
// ----------------------------------------------------------------------------

export interface WorldGeneration {
  /** Max placeable house slots across every category. */
  houseCap?: number;
}

// ----------------------------------------------------------------------------
// Initial generation
// ----------------------------------------------------------------------------

export function generateWorld(
  repo: Pick<RepoData, 'fullName' | 'totalCommits'>,
  ranked: readonly RankedCommit[],
  opts: WorldGeneration = {},
): World {
  const seed = deriveSeed(repo.fullName);
  const rng = createRng(seed);

  // Size inputs: the repo's true commit count drives the skyline (real
  // scale), falling back to the ingested length for sources that don't
  // supply totalCommits (CLI).
  const C = repo.totalCommits ?? ranked.length;
  const counts = computeHouseCounts(C, opts.houseCap);
  const residentialCount = pickResidentialShapes(counts).length;
  const fountainDistricts = pickFountainCount(C);
  const forestDistricts = pickForestCount(C, residentialCount, fountainDistricts);

  const plan = planDistricts({
    counts,
    rng,
    fountainDistricts,
    forestDistricts,
  });

  const districts = toDistricts(plan);
  const occupied = buildOccupiedMaskFromPlan(plan);

  const scenery = buildSceneryFromPlan(plan);
  const objects = buildObjectsFromPlan(plan);
  const agents = placeAgents(ranked, districts, plan, occupied, rng);

  const stats = computeStats(objects, agents, ranked.length, C, counts);

  return {
    version: 1,
    seed,
    archetype: 'generic-settlement',
    palette: 'default',
    grid: plan.grid,
    districts,
    roads: plan.roads,
    objects,
    agents,
    scenery,
    stats,
    ticker: [],
    lastCommitSha: ranked[0]?.sha ?? '',
    generatedAt: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------
// Incremental extension (sync)
//
// Layout is immutable on sync (invariant #2). We recompute the intended
// house counts from the repo's current total and — if the new plan would
// have different counts — we *ignore* the delta and keep the existing
// layout. Regeneration is the only way to resize the city. The agent
// pool gets topped up from the fresh ranked commits that aren't already
// represented.
// ----------------------------------------------------------------------------

export function extendWorld(
  existing: World,
  freshRanked: readonly RankedCommit[],
  freshTotalCommits?: number,
): World {
  if (freshRanked.length === 0) return existing;
  const rng = createRng(`${existing.seed}:${existing.stats.commits}`);

  const occupied = buildOccupiedMask(existing.grid, existing.objects);
  for (const s of existing.scenery) setBit(occupied, s.anchor.x, s.anchor.y, 1);
  for (const a of existing.agents) setBit(occupied, a.spawn.x, a.spawn.y, 1);

  // Top up agents from the fresh commits. District choice falls back to
  // the first populated residential district so agents don't spawn in a
  // forest / fountain / outskirts.
  const target = agentBudget(existing.stats.totalCommits ?? existing.stats.commits);
  const remaining = Math.max(0, target - existing.agents.length);
  const seenAgents = new Set(existing.agents.map((a) => a.id));
  const newAgents: Agent[] = [];

  if (remaining > 0) {
    const homes = residentialDistrictsByArea(existing.districts);
    // Reconstruct a minimal plan-like handle for `findWalkableAnchor`'s
    // fallback pass. We don't keep the original cityRect, so approximate
    // from the existing grid bounds — good enough for spawn tile search.
    const existingPlan: DistrictPlan = {
      grid: existing.grid,
      cityRect: cityRectFromDistricts(existing.districts, existing.grid),
      districts: [],
      roads: [],
    };
    for (const c of freshRanked) {
      if (newAgents.length >= remaining) break;
      if (seenAgents.has(`agent-${c.sha}`)) continue;
      const spawn = findWalkableAnchor(existingPlan, occupied, homes, rng);
      if (!spawn) break;
      setBit(occupied, spawn.tile.x, spawn.tile.y, 1);
      newAgents.push({
        id: `agent-${c.sha}`,
        commitSha: c.sha,
        districtId: spawn.districtId,
        spawn: spawn.tile,
        role: 'wanderer',
        ...commitMeta(c),
      });
    }
  }

  const mergedAgents = existing.agents.concat(newAgents);
  const nextIngested = existing.stats.commits + freshRanked.length;
  const nextTotalCommits =
    freshTotalCommits ?? existing.stats.totalCommits ?? nextIngested;

  return {
    ...existing,
    agents: mergedAgents,
    stats: computeStats(
      existing.objects,
      mergedAgents,
      nextIngested,
      nextTotalCommits,
      // Re-derive counts from the new total so the stats panel stays
      // honest even though layout doesn't resize on sync.
      computeHouseCounts(nextTotalCommits, DEFAULT_HOUSE_CAP),
    ),
    lastCommitSha: freshRanked[0]?.sha ?? existing.lastCommitSha,
    generatedAt: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------
// District / object construction
// ----------------------------------------------------------------------------

function toDistricts(plan: DistrictPlan): District[] {
  const out: District[] = [];
  for (const pd of plan.districts) {
    const cx = Math.round((pd.inner.x0 + pd.inner.x1) / 2);
    const cy = Math.round((pd.inner.y0 + pd.inner.y1) / 2);
    const theme = pd.kind;
    const name = districtDisplayName(pd);
    out.push({
      id: pd.id,
      name,
      isOutskirts: false,
      isGraveyard: false,
      center: { x: cx, y: cy },
      blocks: [pd.inner],
      theme,
    });
  }
  // Synthetic outskirts district — a 1×1 block at the edge of the grid.
  // Required by downstream consumers (scene / sim filters on `isOutskirts`).
  const ox = Math.max(0, plan.grid.w - 1);
  const oy = Math.max(0, plan.grid.h - 1);
  out.push({
    id: 'd-outskirts',
    name: 'outskirts',
    isOutskirts: true,
    isGraveyard: false,
    center: { x: ox, y: oy },
    blocks: [{ x0: ox, y0: oy, x1: ox, y1: oy }],
    theme: 'outskirts',
  });
  return out;
}

function districtDisplayName(pd: PlannedDistrict): string {
  if (pd.kind === 'fountain') return 'plaza';
  if (pd.kind === 'forest') return 'park';
  return `block-${pd.shapeKey}`;
}

function buildOccupiedMaskFromPlan(plan: DistrictPlan): GridMask {
  // Only slot footprints block movement — pavement infill and road tiles
  // are flat surfaces agents walk over. That matches sim's own walkable
  // mask (`buildSimWalkable` = objects only) so the view world-gen has
  // during placement stays consistent with what sim will see at runtime.
  const m = createMask(plan.grid);
  for (const pd of plan.districts) {
    for (const s of pd.slots) {
      const shape = slotFootprint(s.category);
      for (const t of absoluteShape(s.tile, shape)) setBit(m, t.x, t.y, 1);
    }
  }
  return m;
}

function buildSceneryFromPlan(plan: DistrictPlan): SceneryProp[] {
  const out: SceneryProp[] = [];
  for (const pd of plan.districts) {
    for (let i = 0; i < pd.infill.length; i++) {
      const a = pd.infill[i]!;
      const variant = pd.infillVariants[i] ?? 'pavement';
      out.push({
        id: `infill-${pd.id}-${a.x}-${a.y}`,
        variant,
        anchor: { x: a.x, y: a.y },
        rotationY: 0,
      });
    }
  }
  return out;
}

function buildObjectsFromPlan(plan: DistrictPlan): WorldObject[] {
  const out: WorldObject[] = [];
  for (const pd of plan.districts) {
    for (let i = 0; i < pd.slots.length; i++) {
      const slot = pd.slots[i]!;
      const shape = slotFootprint(slot.category);
      const footprint = absoluteShape(slot.tile, shape);
      const variant = variantForCategory(slot.category, pd.id, i);
      out.push({
        id: objectId(pd.id, i),
        // No 1:1 commit mapping in the aggregated model. Empty string
        // keeps the schema satisfied (required: string) while making it
        // obvious to downstream consumers that no commit is attached.
        // Representative-commit attachment can be layered on later
        // (naming phase can still drive displayName off districtId +
        // slot index).
        commitSha: '',
        tier: 'B',
        kind: 'building',
        variant,
        districtId: pd.id,
        anchor: slot.tile,
        footprint,
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Agent placement
//
// Agents wander the city — one per top-ranked commit, up to the budget.
// They spawn on a free tile inside a residential district so the walk
// loop immediately steps onto the adjacent road. Spawn picking is
// RNG-driven but deterministic, and cannot step on a slot footprint,
// infill, or road tile.
// ----------------------------------------------------------------------------

function placeAgents(
  ranked: readonly RankedCommit[],
  districts: readonly District[],
  plan: DistrictPlan,
  occupied: GridMask,
  rng: () => number,
): Agent[] {
  const budget = Math.min(ranked.length, agentBudget(ranked.length));
  if (budget === 0) return [];

  const homes = residentialDistrictsByArea(districts);
  if (homes.length === 0) return [];

  // Keep the occupancy mask read-only across agent placements: agents
  // share infill/road tiles with the scene and are rendered as characters
  // on top, not as footprints. We still avoid already-occupied tiles so
  // sim pathfinding treats them as walkable empty ground.
  const taken = new Set<string>();
  const out: Agent[] = [];

  const sources = ranked.slice(0, budget);
  for (const c of sources) {
    const spawn = findWalkableAnchor(plan, occupied, homes, rng, taken);
    if (!spawn) break;
    taken.add(`${spawn.tile.x},${spawn.tile.y}`);
    out.push({
      id: `agent-${c.sha}`,
      commitSha: c.sha,
      districtId: spawn.districtId,
      spawn: spawn.tile,
      role: 'wanderer',
      ...commitMeta(c),
    });
  }
  return out;
}

function agentBudget(scaleCommits: number): number {
  if (scaleCommits <= 0) return 0;
  const extra = Math.floor(scaleCommits / 500);
  return Math.min(AGENT_BUDGET_MAX, AGENT_BUDGET_BASE + extra);
}

function residentialDistrictsByArea(
  districts: readonly District[],
): District[] {
  return districts
    .filter((d) => !d.isOutskirts && !d.isGraveyard && d.theme === 'residential')
    .sort((a, b) => blockArea(b) - blockArea(a));
}

function blockArea(d: District): number {
  let a = 0;
  for (const b of d.blocks) a += (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  return a;
}

function findWalkableAnchor(
  plan: DistrictPlan,
  occupied: GridMask,
  districts: readonly District[],
  rng: () => number,
  taken: Set<string> = new Set(),
): { tile: TilePos; districtId: string } | null {
  if (districts.length === 0) return null;
  const { grid, cityRect } = plan;
  // First pass: residential inner blocks, so agents prefer standing next
  // to their own house. Descending area order + per-district shuffle
  // prevents clumping in a single corner.
  for (const d of districts) {
    const b = d.blocks[0];
    if (!b) continue;
    const candidates: TilePos[] = [];
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue;
        if (occupied.bits[y * grid.w + x] === 1) continue;
        if (taken.has(`${x},${y}`)) continue;
        candidates.push({ x, y });
      }
    }
    if (candidates.length === 0) continue;
    shuffleInPlace(candidates, rng);
    return { tile: candidates[0]!, districtId: d.id };
  }
  // Fallback: any walkable tile inside the city rect (roads, forest
  // pavement, fountain plaza). Small repos pack most residential tiles
  // into slot footprints, so without this fallback the agent budget
  // collapses to `(innerArea − slots)` — typically 2 for a 3x3 village.
  const pool: TilePos[] = [];
  for (let y = cityRect.y0; y <= cityRect.y1; y++) {
    for (let x = cityRect.x0; x <= cityRect.x1; x++) {
      if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue;
      if (occupied.bits[y * grid.w + x] === 1) continue;
      if (taken.has(`${x},${y}`)) continue;
      pool.push({ x, y });
    }
  }
  if (pool.length === 0) return null;
  shuffleInPlace(pool, rng);
  const tile = pool[0]!;
  return { tile, districtId: nearestDistrictId(tile, districts) };
}

function shuffleInPlace<T>(xs: T[], rng: () => number): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = xs[i]!;
    xs[i] = xs[j]!;
    xs[j] = tmp;
  }
}

function cityRectFromDistricts(
  districts: readonly District[],
  grid: { w: number; h: number },
): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = grid.w, y0 = grid.h, x1 = 0, y1 = 0;
  let any = false;
  for (const d of districts) {
    if (d.isOutskirts) continue;
    for (const b of d.blocks) {
      any = true;
      if (b.x0 < x0) x0 = b.x0;
      if (b.y0 < y0) y0 = b.y0;
      if (b.x1 > x1) x1 = b.x1;
      if (b.y1 > y1) y1 = b.y1;
    }
  }
  if (!any) return { x0: 0, y0: 0, x1: grid.w - 1, y1: grid.h - 1 };
  // Expand by one tile to include the road ring.
  return {
    x0: Math.max(0, x0 - 1),
    y0: Math.max(0, y0 - 1),
    x1: Math.min(grid.w - 1, x1 + 1),
    y1: Math.min(grid.h - 1, y1 + 1),
  };
}

function nearestDistrictId(tile: TilePos, districts: readonly District[]): string {
  let best = districts[0]?.id ?? 'd-outskirts';
  let bestD = Infinity;
  for (const d of districts) {
    const dx = d.center.x - tile.x;
    const dy = d.center.y - tile.y;
    const dsq = dx * dx + dy * dy;
    if (dsq < bestD) {
      bestD = dsq;
      best = d.id;
    }
  }
  return best;
}

// ----------------------------------------------------------------------------
// Per-category footprint & variant selection
// ----------------------------------------------------------------------------

const SHAPE_1x1: FootprintShape = [{ x: 0, y: 0 }];
const SHAPE_2x2: FootprintShape = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
];

function slotFootprint(category: HouseCategory): FootprintShape {
  if (category === 'skyscrapers') return SHAPE_2x2;
  return SHAPE_1x1;
}

function absoluteShape(anchor: TilePos, shape: FootprintShape): TilePos[] {
  return shape.map((t) => ({ x: anchor.x + t.x, y: anchor.y + t.y }));
}

function variantForCategory(
  category: HouseCategory,
  districtId: string,
  slotIdx: number,
): string {
  // Variant keys are contract surface with the renderer's asset table
  // (apps/web/.../scene/assets.ts). Each category picks a pack-local
  // letter deterministically from (districtId, slotIdx) so the same
  // colony always renders the same silhouette per slot.
  const letter = pickLetter(category, `${districtId}:${slotIdx}`);
  return `${variantPrefix(category)}-${letter}`;
}

function variantPrefix(category: HouseCategory): string {
  switch (category) {
    case 'skyscrapers':
      return 'skyscraper';
    case 'threeFloor':
      return 'floor-3';
    case 'twoFloor':
      return 'floor-2';
    case 'oneFloor':
      return 'floor-1';
    case 'rural':
      return 'rural';
  }
}

// Pool size per category. Must match the glb count in the corresponding
// subdirectory under static/models/buildings/<category>/ (see
// scripts/copy-assets.sh).
const POOL_SIZE: Readonly<Record<HouseCategory, number>> = {
  skyscrapers: 5,       // building-skyscraper-a..e
  threeFloor: 14,       // building-a..n (commercial mid-rise)
  twoFloor: 11,         // suburban k..u
  oneFloor: 10,         // suburban a..j
  rural: 5,             // garage + small a..d
};

function pickLetter(category: HouseCategory, key: string): string {
  const idx = fnv1a(key) % POOL_SIZE[category];
  return 'abcdefghijklmnop'.charAt(idx) || 'a';
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ----------------------------------------------------------------------------
// Stats / misc
// ----------------------------------------------------------------------------

function pickFountainCount(C: number): number {
  if (C <= 0) return 0;
  return Math.min(
    MAX_FOUNTAINS,
    FOUNTAIN_BASE + Math.floor(C / 10000) * FOUNTAIN_PER_10K,
  );
}

// Forest share formula: base 0.18, grows with log10(C) up to +0.10,
// hard-capped at 35% of the district mix, and clamped so residential
// districts retain at least RESIDENTIAL_MIN_SHARE of the layout.
function pickForestCount(
  C: number,
  residentialCount: number,
  fountainCount: number,
): number {
  if (C <= 0 || residentialCount === 0) return 0;
  const share =
    FOREST_SHARE_BASE +
    Math.min(
      FOREST_SHARE_GROWTH_MAX,
      FOREST_SHARE_GROWTH_RATE * Math.log10(C + 1),
    );
  const nonForest = residentialCount + fountainCount;
  const target = Math.max(1, Math.round((nonForest * share) / (1 - share)));
  const maxByShare = Math.floor(
    (nonForest * FOREST_MAX_SHARE) / (1 - FOREST_MAX_SHARE),
  );
  const maxByRes = Math.floor(
    residentialCount * ((1 - RESIDENTIAL_MIN_SHARE) / RESIDENTIAL_MIN_SHARE) -
      fountainCount,
  );
  return Math.max(0, Math.min(target, maxByShare, maxByRes));
}

function commitMeta(c: RankedCommit) {
  return {
    message: c.message,
    authorLogin: c.authorLogin,
    authoredAt: c.authoredAt,
  };
}

function computeStats(
  objects: readonly WorldObject[],
  agents: readonly Agent[],
  commitCount: number,
  totalCommits: number | undefined,
  counts?: HouseCounts,
): WorldStats {
  let buildings = 0;
  let decor = 0;
  for (const o of objects) {
    if (o.kind === 'building') buildings++;
    else decor++;
  }
  if (counts) buildings = totalHouses(counts) || buildings;
  return {
    inhabitants: agents.length,
    buildings,
    decor,
    commits: commitCount,
    ...(totalCommits !== undefined ? { totalCommits } : {}),
  };
}

// ----------------------------------------------------------------------------
// Public re-exports for tests / tooling that want the curves directly.
// ----------------------------------------------------------------------------

export { computeHouseCounts };
export type { HouseCounts, HouseCategory } from './houseCounts.js';
