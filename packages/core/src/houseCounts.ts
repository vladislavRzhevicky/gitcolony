// ============================================================================
// Aggregated housing model — points budget + per-type caps.
//
// Replaces the old 1-commit = 1-object pipeline (which drowned 30k+ repos
// in geometry) and the earlier linear-formula version. Now the city is
// sized by two orthogonal curves over C (commit count):
//
//   repo_points(C)    = round(300 + 900 * log10(C + 1))
//   max_buildings(C)  = clamp(round(8 + 8 * log10(C + 1)), 8, 46)
//
// Buildings are placed by a priority round-robin that respects per-type
// caps and the points budget. The result is deterministic (pure math on
// C) and visually balanced: tiny repos still read as a populated village,
// mid-size repos mix low-rise, and 50k+ repos get a skyscraper core.
//
// Per-house cost / tier:
//   rural       =   6 pt — thatched cottage / tiny house
//   oneFloor    =  18 pt — one-floor suburban
//   twoFloor    =  45 pt — two-floor suburban
//   threeFloor  =  95 pt — three-floor mid-rise
//   skyscraper  = 260 pt — downtown tower
//
// Type caps (applied before round-robin):
//   skyscraper  = 0 for C < 1500; else min(floor(C/6000), floor(max*0.20))
//   threeFloor  = floor(max * 0.35)
//   twoFloor    = floor(max * 0.50)
//   oneFloor    = unbounded
//   rural       = unbounded
//
// Priority (round-robin order):
//   small repos (C <  1500): [1f, 2f, 3f, rural]
//   large repos (C >= 1500): [sky, 3f, 2f, 1f, rural]
// ============================================================================

export interface HouseCounts {
  skyscrapers: number;
  threeFloor: number;
  twoFloor: number;
  oneFloor: number;
  rural: number;
}

export type HouseCategory = keyof HouseCounts;

export const HOUSE_CATEGORIES: readonly HouseCategory[] = [
  'skyscrapers',
  'threeFloor',
  'twoFloor',
  'oneFloor',
  'rural',
] as const;

/** Hard ceiling on placeable building slots. Matches max_buildings's upper bound. */
export const DEFAULT_HOUSE_CAP = 46;

/** Points contributed by / cost of a single house of each category. */
export const HOUSE_POINTS: Readonly<Record<HouseCategory, number>> = {
  skyscrapers: 260,
  threeFloor: 95,
  twoFloor: 45,
  oneFloor: 18,
  rural: 6,
};

/** Threshold at which skyscrapers are allowed and the priority switches to large-mode. */
export const LARGE_REPO_THRESHOLD = 1500;

/** Points budget — soft ceiling on category point spend. */
export function repoPoints(C: number): number {
  return Math.round(300 + 900 * Math.log10(Math.max(0, C) + 1));
}

/** Hard ceiling on building count. Clamped to [8, 46] so both ends stay playable. */
export function maxBuildings(C: number): number {
  const raw = Math.round(8 + 8 * Math.log10(Math.max(0, C) + 1));
  return clamp(raw, 8, 46);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Compute per-category house counts for a repo with `C` total commits.
 * Optional `cap` tightens the hard ceiling further (never loosens it past
 * max_buildings(C), which already clamps to 46).
 *
 * Algorithm: classify repo as small / large, build type-cap table,
 * round-robin through the priority list adding one building per pass if
 * budget + caps allow, stop when total hits max_buildings or nothing
 * progresses. Pure, deterministic, idempotent.
 */
export function computeHouseCounts(
  C: number,
  cap?: number,
): HouseCounts {
  if (C <= 0 && cap === undefined) {
    // An honest zero — empty repo, no ingested commits. Keeping the caller
    // contract though: even empty repos show the outskirts fallback, so
    // returning an empty count here is fine.
    return { skyscrapers: 0, threeFloor: 0, twoFloor: 0, oneFloor: 0, rural: 0 };
  }

  const safeC = Math.max(0, C);
  const hardMax =
    cap !== undefined
      ? clamp(cap, 1, maxBuildings(safeC))
      : maxBuildings(safeC);
  const budget = repoPoints(safeC);
  const isLarge = safeC >= LARGE_REPO_THRESHOLD;

  const typeCap: Record<HouseCategory, number> = {
    skyscrapers: safeC >= LARGE_REPO_THRESHOLD
      ? Math.min(Math.floor(safeC / 6000), Math.floor(hardMax * 0.2))
      : 0,
    threeFloor: Math.floor(hardMax * 0.35),
    twoFloor: Math.floor(hardMax * 0.5),
    oneFloor: Number.POSITIVE_INFINITY,
    rural: Number.POSITIVE_INFINITY,
  };

  const priority: HouseCategory[] = isLarge
    ? ['skyscrapers', 'threeFloor', 'twoFloor', 'oneFloor', 'rural']
    : ['oneFloor', 'twoFloor', 'threeFloor', 'rural'];

  const counts: HouseCounts = {
    skyscrapers: 0,
    threeFloor: 0,
    twoFloor: 0,
    oneFloor: 0,
    rural: 0,
  };

  let total = 0;
  let remaining = budget;
  let progressed = true;
  while (total < hardMax && progressed) {
    progressed = false;
    for (const cat of priority) {
      if (total >= hardMax) break;
      if (counts[cat] >= typeCap[cat]) continue;
      const cost = HOUSE_POINTS[cat];
      if (remaining < cost) continue;
      counts[cat]++;
      total++;
      remaining -= cost;
      progressed = true;
    }
  }

  return counts;
}

/** Total houses across every category. */
export function totalHouses(counts: HouseCounts): number {
  return (
    counts.skyscrapers +
    counts.threeFloor +
    counts.twoFloor +
    counts.oneFloor +
    counts.rural
  );
}

/** Total points across every category. */
export function totalPoints(counts: HouseCounts): number {
  return (
    counts.skyscrapers * HOUSE_POINTS.skyscrapers +
    counts.threeFloor * HOUSE_POINTS.threeFloor +
    counts.twoFloor * HOUSE_POINTS.twoFloor +
    counts.oneFloor * HOUSE_POINTS.oneFloor +
    counts.rural * HOUSE_POINTS.rural
  );
}
