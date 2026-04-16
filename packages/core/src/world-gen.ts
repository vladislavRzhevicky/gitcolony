import type {
  Agent,
  ClosedPullRequest,
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
import { arrangeCity, packDistricts } from './layout.js';
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

// Depth-search bounds when choosing how granular district paths should be.
// Uniform-depth selection (old approach) collapsed big repos to <10 districts
// because even at depth=4 most commits landed in the same few parent folders.
// Instead we pick a per-commit path depth: start at depth=1 and repeatedly
// deepen the path of whichever bucket is currently the largest, until either
// we hit the budget-driven target district count or depth saturates. Cap is
// deliberately generous — 50k-commit repos need deep paths (apps/web/src/lib
// style) to surface enough distinct quartiers.
const MIN_DISTRICTS = 4;
const MAX_PATH_DEPTH = 8;
// Width of the road grid between adjacent districts, in tiles.
const ROAD_WIDTH = 1;
// Hard clamps on generated geometry — keeps big repos from producing
// unreadable 200x200 sprawl and tiny repos from collapsing to one pad.
// MAX raised to 192 so a 50k-commit repo with ~36 districts actually gets
// the real estate it was budgeted; 128 clamped big cities back into a small
// crowded square.
const MIN_GRID_SIDE = 48;
const MAX_GRID_SIDE = 192;
const MIN_DISTRICT_SIDE = 7;
const MAX_DISTRICT_SIDE = 14;

// ----------------------------------------------------------------------------
// Volume budgets — how many buildings / residents a world of N commits gets.
//
// Both curves are diminishing so a 10k-commit repo doesn't drown the grid in
// structures. Deterministic, closed-form, easy to re-tune later.
// ----------------------------------------------------------------------------

/**
 * Buildings budget given total commit count.
 *  ≤50 commits   -> 1:1 (tiny repos fill linearly)
 *  >50           -> 50 + (n-50)^0.82   (mild sublinear decay)
 *
 * The previous sqrt-based curve capped at ~260 buildings for 5k commits and
 * ~720 for 50k, which made large repos feel the same size as mid ones.
 * Power 0.82 keeps growth diminishing while preserving real scale.
 *
 * Examples:
 *  170   → 103
 *  500   → 209
 *  1 000 → 347
 *  5 000 → 1 190
 *  50 000 → 7 525
 */
export function buildingsBudget(commits: number): number {
  if (commits <= 0) return 0;
  if (commits <= 50) return commits;
  return Math.round(50 + Math.pow(commits - 50, 0.82));
}

/**
 * Residents (tier-A agents) given already-decided buildings count.
 * Harmonic curve, asymptote at 300. The old 100-resident cap was tuned for
 * tiny cities and saturated immediately once the building curve grew —
 * large cities ended up with ~90 citizens no matter how many structures.
 *
 * Examples:
 *  50    → 43
 *  100   → 75
 *  300   → 150
 *  1 000 → 231
 *  5 000 → 283
 */
export function residentsBudget(buildings: number): number {
  if (buildings <= 0) return 0;
  const n = Math.round(buildings / (1 + buildings / 300));
  return Math.min(300, n);
}

// ----------------------------------------------------------------------------
// Geometry sizing — derive grid and district dimensions from the building
// budget so cities grow with the repo. The first generation computes these
// from `totalCommits`; `extendWorld` reuses the existing grid/districts on
// incremental syncs (full regenerate is the user-facing path to resize).
// ----------------------------------------------------------------------------

/**
 * Number of districts we aim for given a building budget. Growth is slow so
 * per-district density stays readable — 20 structures per quartier is the
 * sweet spot before the pad feels packed.
 */
export function targetDistrictCount(budget: number): number {
  if (budget <= 0) return MIN_DISTRICTS;
  return Math.max(MIN_DISTRICTS, Math.min(36, Math.ceil(budget / 20)));
}

/**
 * District side length (square) sized to comfortably hold its share of the
 * budget. Each 2x1 building plus access needs ~3 tiles; we aim for ~35%
 * building density so there's visible breathing room between structures.
 */
export function chooseDistrictSide(perDistrictBuildings: number): number {
  if (perDistrictBuildings <= 0) return MIN_DISTRICT_SIDE;
  const tilesNeeded = Math.ceil((perDistrictBuildings * 3) / 0.35);
  const side = Math.ceil(Math.sqrt(tilesNeeded));
  return Math.max(MIN_DISTRICT_SIDE, Math.min(MAX_DISTRICT_SIDE, side));
}

/**
 * Grid side needed to fit `districtCount` pads of `districtSide` tiles with
 * a one-tile road gutter and a terrain margin around the city. Clamped to
 * the MIN/MAX_GRID_SIDE range.
 */
export function chooseGridSide(
  districtCount: number,
  districtSide: number,
): number {
  const { cols, rows } = packDistricts(districtCount);
  const cellSize = districtSide + ROAD_WIDTH;
  const cityW = cols * cellSize - ROAD_WIDTH;
  const cityH = rows * cellSize - ROAD_WIDTH;
  const MARGIN = 8;
  const side = Math.max(cityW, cityH) + MARGIN * 2;
  return Math.max(MIN_GRID_SIDE, Math.min(MAX_GRID_SIDE, side));
}

/**
 * Full geometry pass: picks budget → district count → district side → grid
 * side, all derived from the repo's total commit count. Exported so tests
 * and the processor can inspect the intended city shape without running
 * the full placement pipeline.
 */
export interface WorldGeometry {
  grid: GridSize;
  districtSize: GridSize;
  targetDistricts: number;
  buildingsBudget: number;
  residentsBudget: number;
}

export function computeGeometry(totalCommits: number): WorldGeometry {
  const budget = buildingsBudget(totalCommits);
  const targetDistricts = targetDistrictCount(budget);
  return computeGeometryForDistricts(totalCommits, targetDistricts);
}

/**
 * Variant of `computeGeometry` where the caller already knows how many
 * districts will actually be built (post-subdivision). Keeps per-district
 * density readable when the adaptive subdivision couldn't reach the ideal
 * target count.
 */
export function computeGeometryForDistricts(
  totalCommits: number,
  districts: number,
): WorldGeometry {
  const budget = buildingsBudget(totalCommits);
  const count = Math.max(MIN_DISTRICTS, districts);
  const perDistrict = Math.ceil(budget / count);
  const districtSide = chooseDistrictSide(perDistrict);
  const gridSide = chooseGridSide(count, districtSide);
  return {
    grid: { w: gridSide, h: gridSide },
    districtSize: { w: districtSide, h: districtSide },
    targetDistricts: count,
    buildingsBudget: budget,
    residentsBudget: residentsBudget(budget),
  };
}

// ----------------------------------------------------------------------------
// Building kits — "City Kit" tiers unlocked by commit volume. Variants are
// plain `<kit>-<letter>` strings; apps/web/scene/assets.ts maps each kit
// prefix to the matching Kenney City Kit pool.
//
//   suburban   -> City Kit Suburban   (~19 building-type variants)
//   commercial -> City Kit Commercial (~14 + 5 skyscraper variants)
//   industrial -> City Kit Industrial (~20 building-type variants)
// ----------------------------------------------------------------------------

export type BuildingKit = 'suburban' | 'commercial' | 'industrial';

const SUBURBAN_LETTERS = 'abcdefghijklmnopqrs'.split('');
const COMMERCIAL_LETTERS = 'abcdefghijklmn'.split('');
const COMMERCIAL_SKYSCRAPER_LETTERS = 'abcde'.split('');
const INDUSTRIAL_LETTERS = 'abcdefghijklmnopqrst'.split('');

const KIT_VARIANTS: Record<BuildingKit, readonly string[]> = {
  suburban: SUBURBAN_LETTERS.map((l) => `suburban-${l}`),
  commercial: [
    ...COMMERCIAL_LETTERS.map((l) => `commercial-${l}`),
    ...COMMERCIAL_SKYSCRAPER_LETTERS.map((l) => `commercial-skyscraper-${l}`),
  ],
  industrial: INDUSTRIAL_LETTERS.map((l) => `industrial-${l}`),
};

/** Kits unlocked at a given total commit count. */
export function availableKits(commits: number): BuildingKit[] {
  if (commits < 100) return ['suburban'];
  if (commits < 1000) return ['suburban', 'commercial'];
  return ['suburban', 'commercial', 'industrial'];
  // 5000+ will later add a vertical layer (stacked commercial/industrial).
}

/**
 * Per-commit kit pick: heavier commits graduate to heavier kits, but only
 * among the ones the repo size has unlocked. Deterministic in (c, kits).
 */
function pickKitForCommit(c: RankedCommit, kits: readonly BuildingKit[]): BuildingKit {
  const weight = c.additions + c.deletions;
  if (kits.includes('industrial') && weight >= 500) return 'industrial';
  if (kits.includes('commercial') && weight >= 100) return 'commercial';
  return 'suburban';
}

// ----------------------------------------------------------------------------
// Initial generation
// ----------------------------------------------------------------------------

export function generateWorld(
  repo: Pick<RepoData, 'fullName' | 'totalCommits'>,
  ranked: readonly RankedCommit[],
  closedPrs: readonly ClosedPullRequest[] = [],
): World {
  const seed = deriveSeed(repo.fullName);
  const rng = createRng(seed);

  // Size inputs: the repo's true commit count drives geometry so cities
  // scale with the real project, not the ingestion window. Fall back to
  // the ingested length for sources that don't supply totalCommits (CLI).
  const scaleCommits = repo.totalCommits ?? ranked.length;
  const idealGeometry = computeGeometry(scaleCommits);

  // Adaptive subdivision may fall short of the ideal target when the
  // ingested commit window just doesn't touch enough distinct sub-folders.
  // Rebuild geometry against the *actual* district count so the grid and
  // the district pads size themselves to what we'll really place — avoids
  // a sparse 36-slot grid holding 8 districts.
  const remapped = assignPrimaryPaths(ranked, idealGeometry.targetDistricts);
  const distinctNames = new Set<string>();
  for (const c of remapped) if (c.primaryPath) distinctNames.add(c.primaryPath);
  const actualDistricts =
    distinctNames.size + 1 /* outskirts */ + (closedPrs.length > 0 ? 1 : 0);
  const geometry = computeGeometryForDistricts(
    scaleCommits,
    Math.max(MIN_DISTRICTS, actualDistricts),
  );
  const { grid, districtSize } = geometry;

  // Districts are packed into a near-square grid with road gaps between them;
  // both districts and the road network fall out of the same arrangement.
  const { districts, roads } = arrangeCity({
    ranked: remapped,
    grid,
    districtSize,
    roadWidth: ROAD_WIDTH,
    includeGraveyard: closedPrs.length > 0,
  });

  const occupied = buildOccupiedMask(grid, []);
  // Fence around the graveyard district comes FIRST so downstream passes
  // (tree avenue, graves, grass, commit-driven objects) see the perimeter
  // tiles as occupied and never collide with the ring.
  const fences = planGraveyardFence({ districts, occupied, grid });
  // Trees lining the streets are the second source of decor (alongside
  // commit-driven C/D objects). They skip any tile already marked as
  // occupied, so the graveyard fence row stays clean.
  const scenery = planRoadScenery({ roads, districts, occupied, grid });

  // Volume budgets from the geometry pass — derived from the repo's real
  // commit count, not the ingested window. Any tier-B/A commit that
  // overflows its budget is demoted to decor so every repo produces a
  // readable silhouette regardless of size.
  const budgets = {
    buildings: geometry.buildingsBudget,
    residents: geometry.residentsBudget,
  };
  const kits = availableKits(scaleCommits);

  const initialCounts: FillCounts = {
    buildings: new Map(),
    agents: new Map(),
    decor: new Map(),
  };
  const graves = placeGraves(closedPrs, districts, occupied, rng, initialCounts);
  const ghosts = placeGhosts(districts, occupied, rng);
  const { objects, agents } = placeFromCommits(
    remapped,
    districts,
    occupied,
    rng,
    initialCounts,
    budgets,
    kits,
  );

  // Fill the leftover empty tiles inside each non-graveyard district with
  // scattered grass / flower tufts so the pads read as real ground rather
  // than flat colored squares. Runs after placement so grass only lands
  // where nothing else wanted to go. Scenery doesn't block the sim (the
  // walkable mask is built from objects only), so agents can still cross.
  const grassScenery = planGrassFill({
    districts,
    occupied,
    grid,
    rng,
  });

  const stats: WorldStats = computeStats(
    objects,
    agents,
    ranked.length,
    scaleCommits,
  );

  return {
    version: 1,
    seed,
    archetype: 'generic-settlement',
    palette: 'default',
    grid,
    districts,
    roads,
    objects: [...graves, ...objects],
    agents: [...ghosts, ...agents],
    scenery: [...scenery, ...fences, ...grassScenery],
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
  freshClosedPrs: readonly ClosedPullRequest[] = [],
  freshTotalCommits?: number,
): World {
  if (freshRanked.length === 0 && freshClosedPrs.length === 0) return existing;
  const rng = createRng(`${existing.seed}:${existing.stats.commits}`);

  // Match fresh commits against *existing* district names by longest-prefix:
  // if a new commit touched `apps/web/src/lib/foo` and there's already a
  // district called `apps/web/src/lib`, it lands there. Unmatched commits
  // fall through to outskirts the same way first-generation does.
  const remapped = remapAgainstDistricts(freshRanked, existing.districts);

  const occupied = buildOccupiedMask(existing.grid, existing.objects);
  // Carry scenery tiles into the occupancy mask so a sync doesn't try to
  // drop a new building or decor onto a tree planted at first generation.
  for (const s of existing.scenery) setBit(occupied, s.anchor.x, s.anchor.y, 1);

  // Seed per-district fill counts from the existing world so the balancer
  // keeps filling the lightest districts instead of round-robinning from
  // scratch on every sync.
  const counts = seedFillCounts(existing.objects, existing.agents);

  // Recompute budgets against the repo's *current* total commit count (from
  // the fresh observation) falling back to the stored stat, then subtract
  // what's already placed. Worlds that have hit their cap get zero budget
  // for the incremental pass — surplus commits land as decor.
  //
  // Note: grid/districts are NOT resized here even if totalCommits grew past
  // the existing capacity — full regenerate is the user-facing path to grow
  // the city footprint. See the WorldSchema invariant comment.
  const nextIngested = existing.stats.commits + freshRanked.length;
  const nextTotalCommits =
    freshTotalCommits ?? existing.stats.totalCommits ?? nextIngested;
  const totalBuildingsBudget = buildingsBudget(nextTotalCommits);
  const totalResidentsBudget = residentsBudget(totalBuildingsBudget);
  const budgets = {
    buildings: Math.max(0, totalBuildingsBudget - existing.stats.buildings),
    residents: Math.max(0, totalResidentsBudget - existing.stats.inhabitants),
  };
  const kits = availableKits(nextTotalCommits);

  // Place graves for newly-closed PRs first so their tiles are reserved
  // before commit placement starts. Idempotent via obj-pr-<number> ids.
  const existingIds = new Set(existing.objects.map((o) => o.id));
  const freshGraves = placeGraves(
    freshClosedPrs.filter((pr) => !existingIds.has(`obj-pr-${pr.prNumber}`)),
    existing.districts,
    occupied,
    rng,
    counts,
  );

  const { objects: newObjs, agents: newAgents } = placeFromCommits(
    remapped,
    existing.districts,
    occupied,
    rng,
    counts,
    budgets,
    kits,
  );

  // De-dupe defensively by id — ingestion retries must be idempotent.
  const seen = existingIds;
  const mergedObjs = existing.objects.concat(
    freshGraves.filter((o) => !seen.has(o.id)),
    newObjs.filter((o) => !seen.has(o.id)),
  );
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
      nextTotalCommits,
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

// Pick the non-outskirts, non-graveyard district with the smallest count;
// ties broken by district id so reruns with the same inputs yield the same
// placement. Graveyard is excluded so regular commits never bleed into it.
function pickLeastFilled(
  districts: readonly District[],
  counts: Map<string, number>,
): District | null {
  let best: District | null = null;
  let bestCount = Infinity;
  for (const d of districts) {
    if (d.isOutskirts || d.isGraveyard) continue;
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
    .filter((d) => d.id !== primary.id && !d.isOutskirts && !d.isGraveyard)
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
  budgets: { buildings: number; residents: number },
  kits: readonly BuildingKit[],
): { objects: WorldObject[]; agents: Agent[] } {
  const objects: WorldObject[] = [];
  const agents: Agent[] = [];

  // Running totals — once they hit the budget, further tier-A / tier-B
  // commits fall through to decor placement instead of adding another
  // building or agent. Keeps the silhouette readable at any repo size.
  let placedBuildings = 0;
  let placedAgents = 0;

  for (const c of ranked) {
    // Work-in-progress commits become construction-site props instead of
    // buildings. Signals a partial PR until the ingestion pipeline can
    // distinguish open vs merged PRs directly. Doesn't consume the building
    // budget — "work happening on the ground" lives alongside the city.
    if (isWipCommit(c)) {
      const primary = pickLeastFilled(districts, counts.decor);
      if (primary) {
        const placed = findAnchorAcrossDistricts(
          primary,
          districts,
          counts.decor,
          occupied,
          FOOTPRINT_DECOR_1x1,
          rng,
        );
        if (placed) {
          const footprint = absoluteFootprint(placed.anchor, FOOTPRINT_DECOR_1x1);
          markFootprint(occupied, footprint, 1);
          bump(counts.decor, placed.district.id);
          objects.push({
            id: `obj-${c.sha}`,
            commitSha: c.sha,
            tier: 'C',
            kind: 'decor',
            variant: pickConstructionVariant(rng),
            districtId: placed.district.id,
            anchor: placed.anchor,
            footprint,
            ...commitMeta(c),
          });
        }
      }
      continue;
    }

    // Demote tiers that have exhausted their budget so the remainder of the
    // switch handles them as decor. Leaves the incoming commit data alone.
    let effectiveTier: RankedCommit['tier'] = c.tier;
    if (effectiveTier === 'A' && placedAgents >= budgets.residents) {
      effectiveTier = 'C';
    }
    if (effectiveTier === 'B' && placedBuildings >= budgets.buildings) {
      effectiveTier = 'C';
    }
    switch (effectiveTier) {
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
        placedAgents++;
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
        placedBuildings++;
        objects.push({
          id: `obj-${c.sha}`,
          commitSha: c.sha,
          tier: 'B',
          kind: 'building',
          // Volume-unlocked kit picks the model family; commit weight
          // within that kit picks the specific variant.
          variant: pickBuildingVariant(c, kits, rng),
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
        // effectiveTier is used here instead of c.tier so budget-demoted
        // A/B commits end up stored as decor (kind='decor' + tier matching).
        // pickDecorVariant only has tables for C/D; fall through to 'C' for
        // demoted A/B so decoration still renders.
        const decorTier: 'C' | 'D' = effectiveTier === 'D' ? 'D' : 'C';
        objects.push({
          id: `obj-${c.sha}`,
          commitSha: c.sha,
          tier: decorTier,
          kind: 'decor',
          variant: pickDecorVariant(decorTier, rng),
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
// Variant selection — kit is chosen by commit weight within the unlocked set,
// variant is sampled inside that kit. Decor tables are still tier-keyed.
// ----------------------------------------------------------------------------

function pickBuildingVariant(
  c: RankedCommit,
  kits: readonly BuildingKit[],
  rng: () => number,
): string {
  const kit = pickKitForCommit(c, kits);
  const list = KIT_VARIANTS[kit];
  return list[Math.floor(rng() * list.length)] ?? 'suburban-a';
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
// Graveyard routing — closed-but-not-merged pull requests become tombstones.
//
// Each PR maps 1:1 to a `grave-*` decor object in `d-graveyard`, keyed by
// prNumber so re-ingestion is idempotent (invariant #4). The synthetic
// `commitSha = 'pr-<n>'` is used for the variant-pick hash and for
// Picked.commitSha so the side panel has something to display even though
// no real commit is involved.
// ----------------------------------------------------------------------------

function placeGraves(
  closedPrs: readonly ClosedPullRequest[],
  districts: readonly District[],
  occupied: GridMask,
  rng: () => number,
  counts: FillCounts,
): WorldObject[] {
  const graveyard = districts.find((d) => d.isGraveyard) ?? null;
  if (!graveyard || closedPrs.length === 0) return [];
  const out: WorldObject[] = [];
  for (const pr of closedPrs) {
    const placed = findFreeAnchor(occupied, graveyard, FOOTPRINT_DECOR_1x1, rng);
    // Graveyard pad is small (7x7); at ~50 graves we run out of room. Stop
    // silently — extra PRs can still land next sync if tiles free up
    // (they won't, but this keeps the code trivial).
    if (!placed) break;
    const footprint = absoluteFootprint(placed, FOOTPRINT_DECOR_1x1);
    markFootprint(occupied, footprint, 1);
    bump(counts.decor, graveyard.id);
    out.push({
      id: `obj-pr-${pr.prNumber}`,
      commitSha: pr.headSha ?? `pr-${pr.prNumber}`,
      tier: 'C',
      kind: 'decor',
      variant: pickGraveyardVariant(pr, rng),
      districtId: graveyard.id,
      anchor: placed,
      footprint,
      message: `#${pr.prNumber} ${pr.title}`,
      authorLogin: pr.authorLogin,
      authoredAt: pr.closedAt,
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Graveyard ghosts — 2–3 wandering spirits confined to the graveyard district.
//
// Skipped silently when the graveyard is absent or has no free tiles. The
// spawn tile is marked occupied so subsequent passes (graves already ran,
// commit-driven placement next) don't land on top of a ghost.
// ----------------------------------------------------------------------------

const GHOST_COUNT = 3;

function placeGhosts(
  districts: readonly District[],
  occupied: GridMask,
  rng: () => number,
): Agent[] {
  const graveyard = districts.find((d) => d.isGraveyard);
  if (!graveyard) return [];
  const out: Agent[] = [];
  for (let i = 0; i < GHOST_COUNT; i++) {
    const placed = findFreeAnchor(occupied, graveyard, FOOTPRINT_DECOR_1x1, rng);
    if (!placed) break;
    markFootprint(occupied, absoluteFootprint(placed, FOOTPRINT_DECOR_1x1), 1);
    out.push({
      id: `agent-ghost-${i}`,
      commitSha: `ghost-${i}`,
      districtId: graveyard.id,
      spawn: placed,
      role: 'ghost',
    });
  }
  return out;
}

// WIP commits stand in for open pull requests until the ingestion pipeline
// surfaces PR data directly. Covers the common conventions: `WIP:`, `[WIP]`,
// `wip(scope):`, and `draft:`.
const WIP_RE = /^(\[WIP\]|WIP[:\s]|wip(\([^)]+\))?!?:\s|draft(\([^)]+\))?!?:\s)/i;

function isWipCommit(c: RankedCommit): boolean {
  return WIP_RE.test(c.message);
}

const CONSTRUCTION_VARIANTS = [
  'construction-barrier',
  'construction-cone',
  'construction-light',
];

function pickConstructionVariant(rng: () => number): string {
  return (
    CONSTRUCTION_VARIANTS[Math.floor(rng() * CONSTRUCTION_VARIANTS.length)] ??
    'construction-cone'
  );
}

// Graveyard kit variant mix — tombstones are the majority, with occasional
// crosses and coffins for silhouette variety. Props like altars / benches /
// crypts live in scenery rather than here so each commit maps 1:1 to a
// readable grave marker.
const GRAVEYARD_VARIANTS = [
  'grave-bevel',
  'grave-broken',
  'grave-cross',
  'grave-cross-large',
  'grave-debris',
  'grave-decorative',
  'grave-round',
  'grave-wide',
  'grave-roof',
  'grave-plain',
  'grave-border',
  'grave-coffin',
  'grave-cross-wood',
];

function pickGraveyardVariant(_pr: ClosedPullRequest, rng: () => number): string {
  const list = GRAVEYARD_VARIANTS;
  return list[Math.floor(rng() * list.length)] ?? 'grave-bevel';
}

// ----------------------------------------------------------------------------
// Stats
// ----------------------------------------------------------------------------

function computeStats(
  objects: readonly WorldObject[],
  agents: readonly Agent[],
  commitCount: number,
  totalCommits?: number,
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
    ...(totalCommits !== undefined ? { totalCommits } : {}),
  };
}

// ----------------------------------------------------------------------------
// District-path granularity — adaptive subdivision
//
// Why this got rewritten: uniform depth was too coarse for big repos. A 50k-
// commit monorepo at depth=1 collapses every commit into 3-4 top-level dirs;
// bumping to depth=4 still hits the same cap because once a repo has
// `apps/` and `packages/` as its main splits, 90 % of commits share that
// 4-segment prefix. Target-driven subdivision pushes only the crowded buckets
// deeper, leaving sparse ones alone.
// ----------------------------------------------------------------------------

/**
 * Assigns each commit a primaryPath that lives at the shallowest depth where
 * the overall bucket count fits within `targetDistricts`. Greedy: each round
 * picks the currently-largest bucket and deepens the path of every commit
 * inside it. Stops when no bucket can be deepened further (every commit
 * already at MAX_PATH_DEPTH or has a path shorter than current depth).
 */
function assignPrimaryPaths(
  ranked: readonly RankedCommit[],
  targetDistricts: number,
): RankedCommit[] {
  const target = Math.max(MIN_DISTRICTS, targetDistricts);

  // Per-commit current depth + resolved path. Initialised at depth=1.
  // Important: `fallbackDistrictName` (scope / semantic type) only kicks in
  // when the commit carries zero changedFiles — that's the "GraphQL didn't
  // give us paths" bucket. A commit with root-level files (e.g. `README.md`)
  // should fall to outskirts, not be magic'd into a `feat` district.
  const depth = new Map<string, number>();
  const path = new Map<string, string | null>();
  for (const c of ranked) {
    depth.set(c.sha, 1);
    const fromFiles = pickPrimaryPath(c, 1);
    path.set(
      c.sha,
      fromFiles ?? (c.changedFiles.length === 0 ? fallbackDistrictName(c) : null),
    );
  }

  const groupSizes = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const p of path.values()) {
      if (p == null) continue;
      m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  };

  for (let step = 0; step < MAX_PATH_DEPTH * 2; step++) {
    const groups = groupSizes();
    if (groups.size >= target) break;

    // Find the largest bucket that still has room to deepen (at least one
    // commit whose files allow a deeper primary path).
    const ordered = Array.from(groups.entries()).sort((a, b) => b[1] - a[1]);
    let progressed = false;
    for (const [bucket] of ordered) {
      const candidates = ranked.filter((c) => path.get(c.sha) === bucket);
      // Find next depth that would actually produce >1 distinct sub-bucket
      // for this group — deepening uniformly doesn't help if every commit
      // shares the same deeper prefix too.
      let bestDepth = 0;
      let bestSplit = 0;
      for (const c of candidates) {
        const d = depth.get(c.sha) ?? 1;
        for (let nd = d + 1; nd <= MAX_PATH_DEPTH; nd++) {
          const split = new Set<string>();
          for (const cc of candidates) {
            const p = pickPrimaryPath(cc, nd) ?? fallbackDistrictName(cc);
            if (p) split.add(p);
          }
          if (split.size > bestSplit) {
            bestSplit = split.size;
            bestDepth = nd;
          }
          if (split.size > 1) break;
        }
        if (bestSplit > 1) break;
      }
      if (bestSplit > 1 && bestDepth > 0) {
        for (const c of candidates) {
          depth.set(c.sha, bestDepth);
          path.set(
            c.sha,
            pickPrimaryPath(c, bestDepth) ?? fallbackDistrictName(c) ?? bucket,
          );
        }
        progressed = true;
        break; // re-evaluate groups from scratch after a subdivision
      }
    }
    if (!progressed) break;
  }

  return ranked.map((c) => ({ ...c, primaryPath: path.get(c.sha) ?? null }));
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
  // Graveyard bboxes are excluded: we don't want avenue trees breaking the
  // solemn mood or colliding with the iron fence ring.
  const bboxes = districts
    .filter((d) => !d.isGraveyard)
    .map((d) => districtBBox(d, grid));
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
        out.push({ id: `tree-${nx}-${ny}`, variant, anchor: { x: nx, y: ny }, rotationY: 0 });
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Graveyard corner pillars
//
// One `cross-column` pillar on each of the four bbox corners. The full iron
// ring (straight rails + gates) was dropped because the Kenney corner asset
// extends half a tile past its anchor, so with integer tile anchors the
// straight sections could never meet the corners flush.
// ----------------------------------------------------------------------------

interface FenceInput {
  districts: readonly District[];
  occupied: GridMask;
  grid: GridSize;
}

function planGraveyardFence({
  districts,
  occupied,
  grid,
}: FenceInput): SceneryProp[] {
  const graveyard = districts.find((d) => d.isGraveyard);
  if (!graveyard) return [];

  const bbox = districtBBox(graveyard, grid);
  const out: SceneryProp[] = [];

  const pushCorner = (x: number, y: number) => {
    if (!inBounds(occupied, x, y)) return;
    setBit(occupied, x, y, 1);
    out.push({
      id: `cross-column-${x}-${y}`,
      variant: 'cross-column',
      anchor: { x, y },
      rotationY: 0,
    });
  };

  pushCorner(bbox.x0, bbox.y0);
  pushCorner(bbox.x1, bbox.y0);
  pushCorner(bbox.x1, bbox.y1);
  pushCorner(bbox.x0, bbox.y1);
  return out;
}

// ----------------------------------------------------------------------------
// Grass fill — scatters tiny Nature Kit props (grass tufts, flowers, small
// plants) over the empty tiles inside each regular district. Writes only
// into `scenery` so the sim's walkable mask is unaffected.
//
// Density is low by design (PROB ≈ 0.35): districts should read as mostly
// open ground with buildings, not as a meadow. Graveyards are skipped —
// their pad has its own palette and the tombstones carry the mood.
// ----------------------------------------------------------------------------

interface GrassFillInput {
  districts: readonly District[];
  occupied: GridMask;
  grid: GridSize;
  rng: () => number;
}

const GRASS_VARIANTS = [
  'grass-tuft',
  'grass-tuft-large',
  'grass-leafs',
  'flower-red',
  'flower-yellow',
  'flower-purple',
];

const GRASS_PROBABILITY = 0.35;

function planGrassFill({
  districts,
  occupied,
  grid,
  rng,
}: GrassFillInput): SceneryProp[] {
  const out: SceneryProp[] = [];
  for (const d of districts) {
    if (d.isGraveyard || d.isOutskirts) continue;
    const bbox = districtBBox(d, grid);
    for (let y = bbox.y0; y <= bbox.y1; y++) {
      for (let x = bbox.x0; x <= bbox.x1; x++) {
        if (occupied.bits[y * grid.w + x] === 1) continue;
        if (rng() > GRASS_PROBABILITY) continue;
        const variant =
          GRASS_VARIANTS[Math.floor(rng() * GRASS_VARIANTS.length)] ?? 'grass-tuft';
        // Mark as occupied so later placement passes (e.g. syncs) don't
        // drop a building onto a tuft — but scenery isn't in world.objects,
        // so sim's walkable mask stays open and agents can walk through.
        setBit(occupied, x, y, 1);
        out.push({
          id: `grass-${x}-${y}`,
          variant,
          anchor: { x, y },
          rotationY: 0,
        });
      }
    }
  }
  return out;
}

// Matches each fresh commit against the set of existing district names using
// longest-prefix: the file path `apps/web/src/lib/foo.ts` maps to the deepest
// district name it starts with (e.g. `apps/web/src/lib` wins over `apps/web`
// if both exist). Multiple files per commit vote by count; ties broken by
// longer path so deeper quartiers win.
//
// Why this replaced the old inferDepthFromDistricts heuristic: that one assumed
// uniform depth across all districts, which broke when adaptive subdivision
// put `apps/web/src` and `packages` side by side in the same world.
function remapAgainstDistricts(
  ranked: readonly RankedCommit[],
  districts: readonly District[],
): RankedCommit[] {
  const knownPaths = districts
    .filter((d) => !d.isOutskirts && !d.isGraveyard)
    .map((d) => d.name)
    .sort((a, b) => b.length - a.length); // longest first

  const matchFile = (f: string): string | null => {
    const clean = f.replace(/^\/+/, '');
    for (const p of knownPaths) {
      if (clean === p || clean.startsWith(p + '/')) return p;
    }
    return null;
  };

  return ranked.map((c) => {
    if (c.changedFiles.length === 0) {
      return { ...c, primaryPath: fallbackDistrictName(c) };
    }
    const votes = new Map<string, number>();
    for (const f of c.changedFiles) {
      const p = matchFile(f);
      if (p) votes.set(p, (votes.get(p) ?? 0) + 1);
    }
    if (votes.size === 0) {
      return { ...c, primaryPath: fallbackDistrictName(c) };
    }
    let best: string | null = null;
    let bestCount = -1;
    for (const [p, n] of votes) {
      if (
        n > bestCount ||
        (n === bestCount && best !== null && p.length > best.length)
      ) {
        bestCount = n;
        best = p;
      }
    }
    return { ...c, primaryPath: best };
  });
}
