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
  type GridSize,
  FOOTPRINT_BUILDING_2x1,
  FOOTPRINT_DECOR_1x1,
  absoluteFootprint,
  buildOccupiedMask,
  createMask,
  districtBBox,
  findPlacement,
  inBounds,
  markFootprint,
  setBit,
} from './grid.js';
import { arrangeCity } from './layout.js';
import { pickPrimaryPath } from './ranker.js';

// ============================================================================
// MVP world generator.
//
// Builds a World from ranked commits. Layout is deterministic (seeded) and
// collision-resolved: no two objects share a tile, footprints never escape
// the grid or the district bbox.
//
// Invariants maintained (see WorldSchema comments):
//   - seed, archetype, palette, grid, districts -> computed at first generation
//   - objects & agents -> grow incrementally via `extendWorld`, never mutated
//   - placement respects both existing objects and any just-placed in the same
//     call; outskirts acts as fallback district when primary district is full
// ============================================================================

const GRID: GridSize = { w: 48, h: 48 };
// Smaller districts so a typical repo (4-8 directories) yields several
// distinct quartiers instead of one packed slab. Building/decor footprints
// are 2x1 / 1x1, so a 7x7 pad still comfortably holds a handful of each.
const DISTRICT_TILE_SIZE = { w: 7, h: 7 };
// Depth-search bounds when choosing how granular district paths should be.
// We grow depth until we have enough distinct districts, then stop.
const MIN_DISTRICTS = 4;
const MAX_PATH_DEPTH = 3;
// Width of the road grid between adjacent districts, in tiles.
const ROAD_WIDTH = 1;

// ----------------------------------------------------------------------------
// Initial generation
// ----------------------------------------------------------------------------

export function generateWorld(
  repo: Pick<RepoData, 'fullName'>,
  ranked: readonly RankedCommit[],
): World {
  const seed = deriveSeed(repo.fullName);
  const rng = createRng(seed);

  const pathDepth = chooseDistrictDepth(ranked);
  const remapped = remapPrimaryPaths(ranked, pathDepth);

  // Districts are packed into a near-square grid with road gaps between them;
  // both districts and the road network fall out of the same arrangement.
  const { districts, roads } = arrangeCity({
    ranked: remapped,
    grid: GRID,
    districtSize: DISTRICT_TILE_SIZE,
    pathDepth,
    roadWidth: ROAD_WIDTH,
  });

  const occupied = buildOccupiedMask(GRID, []);
  // Trees lining the streets are the second source of decor (alongside
  // commit-driven C/D objects). Plan them first so the placement pass treats
  // their tiles as occupied and doesn't try to drop a building on a tree.
  const scenery = planRoadScenery({ roads, districts, occupied, grid: GRID });
  const { objects, agents } = placeFromCommits(remapped, districts, occupied, rng, {
    buildings: new Map(),
    agents: new Map(),
    decor: new Map(),
  });

  const stats: WorldStats = computeStats(objects, agents, ranked.length);

  return {
    version: 1,
    seed,
    archetype: 'generic-settlement',
    palette: 'default',
    grid: GRID,
    districts,
    roads,
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
// ----------------------------------------------------------------------------

/**
 * Appends freshly-ingested ranked commits to an existing world.
 * Never mutates districts / grid / seed. Collision-resolved against all
 * existing object footprints.
 */
export function extendWorld(
  existing: World,
  freshRanked: readonly RankedCommit[],
): World {
  if (freshRanked.length === 0) return existing;
  const rng = createRng(`${existing.seed}:${existing.stats.commits}`);

  // Mirror the depth that produced the existing districts so freshly-ingested
  // commits land in the same quartiers rather than spawning brand-new ones.
  const depth = inferDepthFromDistricts(existing.districts);
  const remapped = remapPrimaryPaths(freshRanked, depth);

  const occupied = buildOccupiedMask(existing.grid, existing.objects);
  // Carry scenery tiles into the occupancy mask so a sync doesn't try to
  // drop a new building or decor onto a tree planted at first generation.
  for (const s of existing.scenery) setBit(occupied, s.anchor.x, s.anchor.y, 1);

  // Seed per-district fill counts from the existing world so the balancer
  // keeps filling the lightest districts instead of round-robinning from
  // scratch on every sync.
  const counts = seedFillCounts(existing.objects, existing.agents);
  const { objects: newObjs, agents: newAgents } = placeFromCommits(
    remapped,
    existing.districts,
    occupied,
    rng,
    counts,
  );

  // De-dupe defensively by id — ingestion retries must be idempotent.
  const seen = new Set(existing.objects.map((o) => o.id));
  const mergedObjs = existing.objects.concat(newObjs.filter((o) => !seen.has(o.id)));
  const seenAgents = new Set(existing.agents.map((a) => a.id));
  const mergedAgents = existing.agents.concat(
    newAgents.filter((a) => !seenAgents.has(a.id)),
  );

  return {
    ...existing,
    objects: mergedObjs,
    agents: mergedAgents,
    stats: computeStats(
      mergedObjs,
      mergedAgents,
      existing.stats.commits + freshRanked.length,
    ),
    lastCommitSha: freshRanked[0]?.sha ?? existing.lastCommitSha,
    generatedAt: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------
// Object / agent placement
//
// Placement is decoupled from commit semantics by design: the commit's tier
// decides *what* gets built (agent / building / decor), and its semanticType
// decides which model variant is picked — but neither influences *which
// district* the placement lands in. Districts are filled by a least-filled
// balancer so a repo whose commits all point at `src/` doesn't produce one
// packed quartier and three empty pads.
//
// Per-tier fill counts keep buildings and agents balanced independently:
// tier A agents even across districts, tier B buildings even across
// districts, and tier C/D decor even across districts. The balancer ties
// break by district id so placement is fully deterministic.
//
// Outskirts is still the last-resort fallback (invariant #3) but is never a
// primary target — it only receives a placement if every non-outskirts
// district is literally out of space for the given footprint.
// ----------------------------------------------------------------------------

export interface FillCounts {
  buildings: Map<string, number>;
  agents: Map<string, number>;
  decor: Map<string, number>;
}

function bump(m: Map<string, number>, id: string): void {
  m.set(id, (m.get(id) ?? 0) + 1);
}

// Pick the non-outskirts district with the smallest count; ties broken by
// district id so reruns with the same inputs yield the same placement.
function pickLeastFilled(
  districts: readonly District[],
  counts: Map<string, number>,
): District | null {
  let best: District | null = null;
  let bestCount = Infinity;
  for (const d of districts) {
    if (d.isOutskirts) continue;
    const c = counts.get(d.id) ?? 0;
    if (c < bestCount || (c === bestCount && best !== null && d.id < best.id)) {
      bestCount = c;
      best = d;
    }
  }
  return best;
}

// Try the target district first, then every other non-outskirts district in
// (count, id) order, then outskirts. Returns the district that accepted the
// footprint and its anchor, or null if nothing fit.
function findAnchorAcrossDistricts(
  primary: District,
  districts: readonly District[],
  counts: Map<string, number>,
  occupied: GridMask,
  shape: FootprintShape,
  rng: () => number,
): { district: District; anchor: TilePos } | null {
  const tryOrder: District[] = [primary];
  const rest = districts
    .filter((d) => d.id !== primary.id && !d.isOutskirts)
    .sort((a, b) => {
      const ca = counts.get(a.id) ?? 0;
      const cb = counts.get(b.id) ?? 0;
      if (ca !== cb) return ca - cb;
      return a.id < b.id ? -1 : 1;
    });
  tryOrder.push(...rest);
  const outskirts = districts.find((d) => d.isOutskirts);
  if (outskirts) tryOrder.push(outskirts);

  for (const d of tryOrder) {
    const anchor = findFreeAnchor(occupied, d, shape, rng);
    if (anchor) return { district: d, anchor };
  }
  return null;
}

function placeFromCommits(
  ranked: readonly RankedCommit[],
  districts: readonly District[],
  occupied: GridMask,
  rng: () => number,
  counts: FillCounts,
): { objects: WorldObject[]; agents: Agent[] } {
  const objects: WorldObject[] = [];
  const agents: Agent[] = [];

  for (const c of ranked) {
    switch (c.tier) {
      case 'A': {
        const primary = pickLeastFilled(districts, counts.agents);
        if (!primary) break;
        const placed = findAnchorAcrossDistricts(
          primary,
          districts,
          counts.agents,
          occupied,
          FOOTPRINT_DECOR_1x1,
          rng,
        );
        if (!placed) break;
        // Reserve the spawn tile so nothing else lands on it. Sim will move
        // the agent later; for world-gen determinism we treat it as occupied.
        markFootprint(occupied, absoluteFootprint(placed.anchor, FOOTPRINT_DECOR_1x1), 1);
        bump(counts.agents, placed.district.id);
        agents.push({
          id: `agent-${c.sha}`,
          commitSha: c.sha,
          districtId: placed.district.id,
          spawn: placed.anchor,
          role: 'wanderer',
          ...commitMeta(c),
        });
        break;
      }
      case 'B': {
        const primary = pickLeastFilled(districts, counts.buildings);
        if (!primary) break;
        const placed = findAnchorAcrossDistricts(
          primary,
          districts,
          counts.buildings,
          occupied,
          FOOTPRINT_BUILDING_2x1,
          rng,
        );
        if (!placed) break;
        const footprint = absoluteFootprint(placed.anchor, FOOTPRINT_BUILDING_2x1);
        markFootprint(occupied, footprint, 1);
        bump(counts.buildings, placed.district.id);
        objects.push({
          id: `obj-${c.sha}`,
          commitSha: c.sha,
          tier: 'B',
          kind: 'building',
          // Variant still derives from semanticType — that's the only
          // channel through which commit type reaches the scene.
          variant: pickBuildingVariant(c.semanticType, rng),
          districtId: placed.district.id,
          anchor: placed.anchor,
          footprint,
          height: buildingHeight(c),
          ...commitMeta(c),
        });
        break;
      }
      case 'C':
      case 'D': {
        const primary = pickLeastFilled(districts, counts.decor);
        if (!primary) break;
        const placed = findAnchorAcrossDistricts(
          primary,
          districts,
          counts.decor,
          occupied,
          FOOTPRINT_DECOR_1x1,
          rng,
        );
        if (!placed) break;
        const footprint = absoluteFootprint(placed.anchor, FOOTPRINT_DECOR_1x1);
        markFootprint(occupied, footprint, 1);
        bump(counts.decor, placed.district.id);
        objects.push({
          id: `obj-${c.sha}`,
          commitSha: c.sha,
          tier: c.tier,
          kind: 'decor',
          variant: pickDecorVariant(c.tier, rng),
          districtId: placed.district.id,
          anchor: placed.anchor,
          footprint,
          ...commitMeta(c),
        });
        break;
      }
    }
  }

  return { objects, agents };
}

// Prime per-district fill counts from an existing world so incremental
// sync keeps filling the lightest districts — without this, extendWorld
// would round-robin from zero and worsen balance over time.
function seedFillCounts(
  objects: readonly WorldObject[],
  agents: readonly Agent[],
): FillCounts {
  const counts: FillCounts = {
    buildings: new Map(),
    agents: new Map(),
    decor: new Map(),
  };
  for (const o of objects) {
    if (o.kind === 'building') bump(counts.buildings, o.districtId);
    else bump(counts.decor, o.districtId);
  }
  for (const a of agents) bump(counts.agents, a.districtId);
  return counts;
}

function findFreeAnchor(
  occupied: GridMask,
  district: District,
  shape: FootprintShape,
  rng: () => number,
) {
  const bbox = districtBBox(district, { w: occupied.w, h: occupied.h });
  return findPlacement(occupied, bbox, shape, rng);
}

// ----------------------------------------------------------------------------
// Variant selection — stable tables, no cross-tier bleed.
// ----------------------------------------------------------------------------

const BUILDING_VARIANTS = {
  feat: ['workshop-01', 'workshop-02', 'house-02'],
  fix: ['clinic-01', 'repair-01'],
  refactor: ['hall-01', 'hall-02'],
  docs: ['library-01', 'archive-01'],
  test: ['tower-01', 'tower-02'],
  chore: ['storage-01', 'storage-02'],
  unknown: ['house-01', 'house-02'],
} as const;

function pickBuildingVariant(t: RankedCommit['semanticType'], rng: () => number): string {
  const list = BUILDING_VARIANTS[t];
  return list[Math.floor(rng() * list.length)] ?? 'house-01';
}

// Commit metadata carried onto placed objects/agents so the renderer's
// side-panel can read it without a second lookup. Subset of Commit: no
// changedFiles (too heavy) and no additions/deletions (redundant with
// visual height for tier B).
function commitMeta(c: RankedCommit) {
  return {
    message: c.message,
    authorLogin: c.authorLogin,
    authoredAt: c.authoredAt,
  };
}

// Building height in world units. Driven by commit weight (additions+deletions
// capped to avoid megastructures from refactor-style commits). Deterministic
// so re-generation yields the same silhouette. 1..4 units.
function buildingHeight(c: RankedCommit): number {
  const weight = Math.min(2000, c.additions + c.deletions);
  // log-scale so a 2000-line rewrite isn't 10x the height of a 20-line fix.
  const norm = Math.log1p(weight) / Math.log1p(2000); // 0..1
  return 1 + Math.round(norm * 30) / 10; // 1.0..4.0, 0.1 steps
}

const DECOR_C = ['tree-01', 'tree-02', 'lamp-01', 'bush-01', 'rock-01', 'crate-01'];
const DECOR_D = ['grass-01', 'grass-02', 'pebbles-01', 'flower-01'];

function pickDecorVariant(tier: 'C' | 'D', rng: () => number): string {
  const list = tier === 'C' ? DECOR_C : DECOR_D;
  return list[Math.floor(rng() * list.length)] ?? 'grass-01';
}

// ----------------------------------------------------------------------------
// Stats
// ----------------------------------------------------------------------------

function computeStats(
  objects: readonly WorldObject[],
  agents: readonly Agent[],
  commitCount: number,
): WorldStats {
  let buildings = 0;
  let decor = 0;
  for (const o of objects) {
    if (o.kind === 'building') buildings++;
    else decor++;
  }
  return {
    inhabitants: agents.length,
    buildings,
    decor,
    commits: commitCount,
  };
}

// ----------------------------------------------------------------------------
// District-path granularity
//
// Default depth=1 (top-level dir) collapses repos with a single root folder
// (`src/`, `app/`) into one district. We grow depth until the commit set
// produces enough distinct paths to fill out a proper city, then cap.
// ----------------------------------------------------------------------------

function chooseDistrictDepth(ranked: readonly RankedCommit[]): number {
  for (let depth = 1; depth <= MAX_PATH_DEPTH; depth++) {
    const distinct = new Set<string>();
    for (const c of ranked) {
      const p = pickPrimaryPath(c, depth) ?? fallbackDistrictName(c);
      if (p) distinct.add(p);
    }
    if (distinct.size >= MIN_DISTRICTS) return depth;
  }
  return MAX_PATH_DEPTH;
}

function remapPrimaryPaths(
  ranked: readonly RankedCommit[],
  depth: number,
): RankedCommit[] {
  return ranked.map((c) => {
    const fromFiles = pickPrimaryPath(c, depth);
    return { ...c, primaryPath: fromFiles ?? fallbackDistrictName(c) };
  });
}

// Fallback path used when the GitHub fetcher couldn't supply changedFiles
// (the GraphQL history endpoint doesn't return paths; REST enrichment is
// post-MVP). We mine the conventional-commit scope first — `feat(auth):`
// is a strong signal — and fall back to the semantic type so the city
// always splits into a few distinct districts instead of dumping every
// commit into the outskirts.
const SCOPE_RE = /^(?:feat|fix|refactor|docs|test|chore|build|ci|perf|style|revert)\(([^)]+)\)!?:/i;

function fallbackDistrictName(c: RankedCommit): string | null {
  const m = c.message.match(SCOPE_RE);
  if (m && m[1]) {
    const scope = m[1].trim();
    if (scope) return scope;
  }
  return c.semanticType !== 'unknown' ? c.semanticType : null;
}

// ----------------------------------------------------------------------------
// Road-side scenery
//
// For every road tile we look at its 4-neighbors. A neighbor that sits
// inside a district pad (so it's "the edge of a block") and isn't itself a
// road or already occupied gets a tree. We mark the chosen tiles as
// occupied in the shared mask so commit-driven placement won't fight the
// tree row for the same tile.
//
// Trees are deterministic: the variant cycles by (x+y) parity so two
// adjacent trees alternate `tree-01` / `tree-02` and the row reads as a
// proper avenue rather than a copy-pasted hedge.
// ----------------------------------------------------------------------------

interface RoadSceneryInput {
  roads: readonly TilePos[][];
  districts: readonly District[];
  occupied: GridMask;
  grid: GridSize;
}

const TREE_VARIANTS = ['tree-01', 'tree-02'];

function planRoadScenery({
  roads,
  districts,
  occupied,
  grid,
}: RoadSceneryInput): SceneryProp[] {
  // Fast lookup: which tiles are roads?
  const roadMask = createMask(grid);
  for (const path of roads) {
    for (const t of path) setBit(roadMask, t.x, t.y, 1);
  }

  // Per-district bbox — a tree only counts as "road-side" if it sits inside
  // some district. (Tiles outside every district are just open ground.)
  const bboxes = districts.map((d) => districtBBox(d, grid));
  const insideAnyDistrict = (x: number, y: number) =>
    bboxes.some(
      (b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1,
    );

  const out: SceneryProp[] = [];
  // Walking road tiles in a stable order (rows of roads come in arrangeCity
  // order, then path order). The set ensures we don't re-plant the same tile
  // twice when two roads touch the same neighbor.
  const planted = new Set<number>();
  const key = (x: number, y: number) => y * grid.w + x;

  for (const path of roads) {
    for (const t of path) {
      for (const [dx, dy] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ] as const) {
        const nx = t.x + dx;
        const ny = t.y + dy;
        if (!inBounds(occupied, nx, ny)) continue;
        if (roadMask.bits[ny * grid.w + nx] === 1) continue;
        if (occupied.bits[ny * grid.w + nx] === 1) continue;
        if (!insideAnyDistrict(nx, ny)) continue;
        // Sparse planting: every other tile so the avenue reads as a row
        // of trees, not a continuous hedge.
        if ((nx + ny) % 2 !== 0) continue;
        const k = key(nx, ny);
        if (planted.has(k)) continue;
        planted.add(k);
        setBit(occupied, nx, ny, 1);
        const variant = TREE_VARIANTS[(nx + ny) % TREE_VARIANTS.length]!;
        out.push({ id: `tree-${nx}-${ny}`, variant, anchor: { x: nx, y: ny } });
      }
    }
  }
  return out;
}

// District names are derived from the source paths, so the deepest slash
// count among non-outskirts districts tells us which depth produced them.
function inferDepthFromDistricts(districts: readonly District[]): number {
  let depth = 1;
  for (const d of districts) {
    if (d.isOutskirts) continue;
    // Names are joined with '/' before slugify replaces '/' with '-'.
    // After slugify we count '-' as a proxy for path segments. This is a
    // best-effort heuristic — fine because remapPrimaryPaths is only used
    // to bucket *new* commits into existing districts via the same hash.
    const segs = d.name.split('/').length;
    if (segs > depth) depth = segs;
  }
  return Math.min(depth, MAX_PATH_DEPTH);
}
