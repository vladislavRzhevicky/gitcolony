import type { Rect, Road, TilePos } from '@gitcolony/schema';
import type { HouseCategory, HouseCounts } from './houseCounts.js';
import type { GridSize } from './grid.js';

// ============================================================================
// District planner.
//
// Given a HouseCounts object, emits a list of axis-aligned district blocks
// on a deterministic grid. Each district is either:
//
//   residential — one of {1x4, 4x1, 2x2, 2x4, 4x2, 2x6, 6x2, 3x3}; holds
//                 house slots for skyscrapers / multi-floor / rural
//   forest      — 1x2 or 2x1; filled with grass / grass-trees / tall
//   fountain    — 1x1; a single pavement-fountain tile
//
// Each district has a road-ring footprint = (inner shape + 1 tile on every
// side). Districts are packed row-wise with the rings overlapping so the
// network of roads is continuous.
//
// Invariants:
//   - planning is deterministic for a given (counts, seed) input
//   - interior tiles never intersect roads (roads live on the ring tiles)
//   - all coordinates are non-negative and fit within the returned grid
// ============================================================================

export type DistrictKind = 'residential' | 'forest' | 'fountain';

// Inner-shape tile size (width/height in tiles), before the 1-tile road
// ring is added. Keep in sync with RESIDENTIAL_TEMPLATES below.
export interface ShapeSize {
  w: number;
  h: number;
}

export interface PlannedSlot {
  /** Position inside the district's inner rect, in district-local coords. */
  local: TilePos;
  /** Absolute world-tile coords. */
  tile: TilePos;
  /** Which house category owns this slot. */
  category: HouseCategory;
}

export interface PlannedDistrict {
  id: string;
  kind: DistrictKind;
  /** Inner shape rect (excludes the road ring). */
  inner: Rect;
  /**
   * Shape key for residential/forest so consumers can reason about density
   * without re-deriving it from width/height. `'1x1'` for fountain.
   */
  shapeKey: string;
  /** House slots (empty for forest / fountain). */
  slots: PlannedSlot[];
  /**
   * Interior tiles *not* taken by a house slot. Used by the renderer to
   * paint pavement (residential), pavement-fountain (fountain), or grass
   * variants (forest) between buildings.
   */
  infill: TilePos[];
  /**
   * Infill variant per tile (same order as `infill`). For residential the
   * value is always `'pavement'`; fountain districts always contain a
   * single `'pavement-fountain'`; forest districts pick among
   * `grass | grass-trees | grass-trees-tall` deterministically.
   */
  infillVariants: string[];
}

export interface DistrictPlan {
  grid: GridSize;
  cityRect: Rect;
  districts: PlannedDistrict[];
  roads: Road[];
}

// ----------------------------------------------------------------------------
// Shape templates — residential layouts.
//
// Positions are district-local (origin top-left). The template says how a
// district of this shape pins house slots to tiles; the remaining tiles in
// the inner rect are infill (pavement). Templates follow the spec's
// density guidance: 1x4/2x2 packed, 2x4/2x6 staggered with gaps, 3x3 with
// courtyard.
//
// Each template lists slots in fill priority order — the district is
// filled left-to-right across this list until the caller runs out of
// houses to place, so partially-filled districts still read as roads +
// perimeter buildings rather than "houses scattered anywhere".
// ----------------------------------------------------------------------------

const P = (x: number, y: number): TilePos => ({ x, y });

export interface ResidentialTemplate {
  key: string;
  w: number;
  h: number;
  slots: readonly TilePos[];
}

export const RESIDENTIAL_TEMPLATES: readonly ResidentialTemplate[] = [
  // 1x4: a tight row of 4 houses.
  { key: '1x4', w: 4, h: 1, slots: [P(0, 0), P(1, 0), P(2, 0), P(3, 0)] },
  // 4x1: same row, transposed.
  { key: '4x1', w: 1, h: 4, slots: [P(0, 0), P(0, 1), P(0, 2), P(0, 3)] },
  // 2x2: four houses packed, no gaps.
  { key: '2x2', w: 2, h: 2, slots: [P(0, 0), P(1, 0), P(0, 1), P(1, 1)] },
  // 2x4: 6 houses with two paved gaps on the back row.
  {
    key: '2x4',
    w: 4,
    h: 2,
    slots: [P(0, 0), P(1, 0), P(2, 0), P(3, 0), P(0, 1), P(2, 1)],
  },
  // 4x2: 6 houses, transposed.
  {
    key: '4x2',
    w: 2,
    h: 4,
    slots: [P(0, 0), P(0, 1), P(0, 2), P(0, 3), P(1, 0), P(1, 2)],
  },
  // 2x6: 6 houses in a staggered checker across a 2×6 block.
  {
    key: '2x6',
    w: 6,
    h: 2,
    slots: [P(0, 0), P(2, 0), P(4, 0), P(1, 1), P(3, 1), P(5, 1)],
  },
  // 6x2: transposed checker.
  {
    key: '6x2',
    w: 2,
    h: 6,
    slots: [P(0, 0), P(0, 2), P(0, 4), P(1, 1), P(1, 3), P(1, 5)],
  },
  // 3x3: 8 houses around a central paved courtyard.
  {
    key: '3x3',
    w: 3,
    h: 3,
    slots: [
      P(0, 0), P(1, 0), P(2, 0),
      P(0, 1),          P(2, 1),
      P(0, 2), P(1, 2), P(2, 2),
    ],
  },
];

const TEMPLATE_BY_KEY: Readonly<Record<string, ResidentialTemplate>> =
  Object.fromEntries(RESIDENTIAL_TEMPLATES.map((t) => [t.key, t]));

/** Lookup helper for consumers that need the raw template. */
export function residentialTemplate(key: string): ResidentialTemplate | null {
  return TEMPLATE_BY_KEY[key] ?? null;
}

// Capacity (slot count) per template, used by the shape picker below.
function cap(key: string): number {
  return TEMPLATE_BY_KEY[key]?.slots.length ?? 0;
}

// Preferred shape order — bigger shapes first so repos with many houses
// concentrate into fewer, denser districts (spec: "сначала увеличивать
// размер района, потом плотность"). When the remaining house budget no
// longer fills the biggest shape we fall to the next smaller size.
const SHAPE_ORDER_BIG: readonly string[] = ['3x3', '2x6', '6x2', '2x4', '4x2', '1x4', '4x1', '2x2'];
const SHAPE_ORDER_SMALL: readonly string[] = ['2x2', '1x4', '4x1', '2x4', '4x2', '3x3', '2x6', '6x2'];

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export interface PlanOptions {
  counts: HouseCounts;
  rng: () => number;
  /**
   * How many forest districts to include. Grows modestly with scale so
   * cities aren't asphalt-only but never dominates the frame. Caller
   * passes a derived value; planner honors it verbatim.
   */
  forestDistricts?: number;
  /**
   * Fountain (plaza) districts. Typically 1 for villages, 2-3 for larger
   * cities. Also passed in by the caller so world-gen stays the policy
   * owner.
   */
  fountainDistricts?: number;
}

export function planDistricts({
  counts,
  rng,
  forestDistricts = 0,
  fountainDistricts = 0,
}: PlanOptions): DistrictPlan {
  const residentialShapes = pickResidentialShapes(counts);

  // Full shape inventory to pack — residential first (ordered by category
  // priority so dense skyscraper blocks land near the city center),
  // forest, then fountains. Packing is purely geometric; nothing here
  // uses the category assignments yet.
  const shapes: PackingShape[] = [];
  for (const item of residentialShapes) {
    const t = TEMPLATE_BY_KEY[item.shapeKey]!;
    shapes.push({
      kind: 'residential',
      w: t.w,
      h: t.h,
      shapeKey: t.key,
      assignments: item.assignments,
    });
  }
  for (let i = 0; i < forestDistricts; i++) {
    const vertical = rng() < 0.5;
    shapes.push({
      kind: 'forest',
      w: vertical ? 1 : 2,
      h: vertical ? 2 : 1,
      shapeKey: vertical ? '1x2' : '2x1',
      assignments: [],
    });
  }
  for (let i = 0; i < fountainDistricts; i++) {
    shapes.push({
      kind: 'fountain',
      w: 1,
      h: 1,
      shapeKey: '1x1',
      assignments: [],
    });
  }

  const packed = packRows(shapes);

  const districts: PlannedDistrict[] = [];
  let idSeq = 0;
  for (const p of packed.rows) {
    const inner: Rect = {
      x0: p.x,
      y0: p.y,
      x1: p.x + p.w - 1,
      y1: p.y + p.h - 1,
    };
    const id = `d-${p.shape.kind}-${idSeq++}`;
    districts.push(finalizeDistrict(id, p.shape, inner, rng));
  }

  const roads = buildRoadRings(districts, packed.grid);
  return {
    grid: packed.grid,
    cityRect: packed.cityRect,
    districts,
    roads,
  };
}

// ----------------------------------------------------------------------------
// Residential shape selection.
//
// Distributes the 5 category totals across a set of residential districts.
// Strategy: pack skyscrapers into 2x2 blocks (exclusive — one skyscraper
// per district so its silhouette reads; the `2x2` shape gives the ring
// road some mass around it). Everything else flows into bigger shapes
// first (3x3 → 2x6 → 2x4 → 1x4 → 2x2), filling slots by descending
// category weight so the heaviest category anchors the biggest shape.
// ----------------------------------------------------------------------------

export interface ResidentialShapePick {
  shapeKey: string;
  assignments: HouseCategory[];
}

export function pickResidentialShapes(counts: HouseCounts): ResidentialShapePick[] {
  const out: ResidentialShapePick[] = [];

  // Skyscrapers own an entire 2x2 district each — the shape is shared
  // with mid-rise 2x2 blocks but never mixed with them.
  for (let i = 0; i < counts.skyscrapers; i++) {
    out.push({ shapeKey: '2x2', assignments: ['skyscrapers'] });
  }

  // Queue of remaining houses, heavy categories first. Each house in the
  // queue consumes one slot in whichever shape we pick next.
  const queue: HouseCategory[] = [];
  for (let i = 0; i < counts.threeFloor; i++) queue.push('threeFloor');
  for (let i = 0; i < counts.twoFloor; i++) queue.push('twoFloor');
  for (let i = 0; i < counts.oneFloor; i++) queue.push('oneFloor');
  for (let i = 0; i < counts.rural; i++) queue.push('rural');

  while (queue.length > 0) {
    const shape = chooseShape(queue.length);
    const take = Math.min(queue.length, cap(shape));
    const assignments = queue.splice(0, take);
    out.push({ shapeKey: shape, assignments });
  }

  return out;
}

function chooseShape(remaining: number): string {
  // Pick the largest template that doesn't waste more than ~30% of its
  // slots. For small repos the picker falls through to the smallest
  // available shape.
  for (const key of SHAPE_ORDER_BIG) {
    const c = cap(key);
    if (c <= remaining) return key;
    if (remaining >= Math.ceil(c * 0.7)) return key;
  }
  for (const key of SHAPE_ORDER_SMALL) {
    const c = cap(key);
    if (c <= remaining) return key;
  }
  return '2x2';
}

// ----------------------------------------------------------------------------
// Row packer.
//
// Simple shelf packer: each row is as tall as the tallest shape placed in
// it, plus one tile above and below for the shared road ring. New rows
// start when the current row's x-cursor would overflow a target width
// chosen to keep the city roughly square.
//
// The final cityRect / grid size is computed from the resulting bounds
// plus margins.
// ----------------------------------------------------------------------------

interface PackingShape {
  kind: DistrictKind;
  w: number;
  h: number;
  shapeKey: string;
  assignments: HouseCategory[];
}

interface PackedShape {
  shape: PackingShape;
  /** Absolute tile of the inner rect's top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PackResult {
  grid: GridSize;
  cityRect: Rect;
  rows: PackedShape[];
}

// Fixed tile margin between the city rect and the grid border. Leaves
// room for the island terrain ring without spilling the city into the
// grid edge.
const CITY_MARGIN = 6;
// One tile wide road separator between shapes within a row and between
// rows. The ring around every district is 1 tile; adjacent districts
// share that tile so the network stays continuous.
const ROAD_GAP = 1;

function packRows(shapes: readonly PackingShape[]): PackResult & { rows: PackedShape[] } {
  if (shapes.length === 0) {
    const cityRect: Rect = { x0: CITY_MARGIN, y0: CITY_MARGIN, x1: CITY_MARGIN + 4, y1: CITY_MARGIN + 4 };
    return {
      grid: { w: cityRect.x1 + CITY_MARGIN + 1, h: cityRect.y1 + CITY_MARGIN + 1 },
      cityRect,
      rows: [],
    };
  }

  // Target row width sized so rows end up roughly as wide as they are
  // tall. Assume each shape averages 3×3 tiles (including gap); tune if
  // the average mix changes.
  const estArea = shapes.reduce((s, sh) => s + (sh.w + ROAD_GAP) * (sh.h + ROAD_GAP), 0);
  const targetRowWidth = Math.max(6, Math.ceil(Math.sqrt(estArea)));

  const packed: PackedShape[] = [];
  // Origin at (CITY_MARGIN + ROAD_GAP, CITY_MARGIN + ROAD_GAP) so the
  // outer road ring has room on the west/north sides.
  const originX = CITY_MARGIN + ROAD_GAP;
  const originY = CITY_MARGIN + ROAD_GAP;

  let cursorX = originX;
  let cursorY = originY;
  let rowHeight = 0;

  // Sort: residentials first, biggest first (so skyscraper/large shapes
  // anchor the city center), then forest and fountains. Stable within a
  // kind so seeded ordering from pickResidentialShapes is preserved.
  const ordered = [...shapes].sort((a, b) => {
    const ak = kindOrder(a.kind);
    const bk = kindOrder(b.kind);
    if (ak !== bk) return ak - bk;
    return b.w * b.h - a.w * a.h;
  });

  for (const shape of ordered) {
    if (cursorX !== originX && cursorX - originX + shape.w > targetRowWidth) {
      // Start a new row; `rowHeight` is the max inner height in the
      // previous row, and we leave ROAD_GAP tiles of road between rows.
      cursorX = originX;
      cursorY += rowHeight + ROAD_GAP;
      rowHeight = 0;
    }
    packed.push({ shape, x: cursorX, y: cursorY, w: shape.w, h: shape.h });
    cursorX += shape.w + ROAD_GAP;
    if (shape.h > rowHeight) rowHeight = shape.h;
  }

  // Compute cityRect bounds from placed shapes.
  let maxX = originX;
  let maxY = originY;
  for (const p of packed) {
    if (p.x + p.w > maxX) maxX = p.x + p.w;
    if (p.y + p.h > maxY) maxY = p.y + p.h;
  }
  const cityRect: Rect = {
    x0: CITY_MARGIN,
    y0: CITY_MARGIN,
    x1: maxX,
    y1: maxY,
  };
  const grid: GridSize = {
    w: cityRect.x1 + CITY_MARGIN + 1,
    h: cityRect.y1 + CITY_MARGIN + 1,
  };
  return { grid, cityRect, rows: packed };
}

function kindOrder(k: DistrictKind): number {
  if (k === 'residential') return 0;
  if (k === 'fountain') return 1;
  return 2;
}

// ----------------------------------------------------------------------------
// Finalize a packed shape into a PlannedDistrict.
//
// Residential: walk the template's slots in order, assign each to a
// category from `assignments` (same order — heaviest first). Leftover
// tiles inside the inner rect become pavement infill.
//
// Forest: every tile in the inner rect is grass infill, picked from a
// weighted pool for variety.
//
// Fountain: the single tile is a pavement-fountain infill, no slots.
// ----------------------------------------------------------------------------

const FOREST_VARIANTS: readonly string[] = [
  'grass',
  'grass-trees',
  'grass-trees-tall',
  'grass-trees',
  'grass',
];

function finalizeDistrict(
  id: string,
  shape: PackingShape,
  inner: Rect,
  rng: () => number,
): PlannedDistrict {
  if (shape.kind === 'fountain') {
    return {
      id,
      kind: 'fountain',
      inner,
      shapeKey: shape.shapeKey,
      slots: [],
      infill: [{ x: inner.x0, y: inner.y0 }],
      infillVariants: ['pavement-fountain'],
    };
  }

  if (shape.kind === 'forest') {
    const infill: TilePos[] = [];
    const infillVariants: string[] = [];
    for (let y = inner.y0; y <= inner.y1; y++) {
      for (let x = inner.x0; x <= inner.x1; x++) {
        infill.push({ x, y });
        infillVariants.push(
          FOREST_VARIANTS[Math.floor(rng() * FOREST_VARIANTS.length)] ?? 'grass',
        );
      }
    }
    return {
      id,
      kind: 'forest',
      inner,
      shapeKey: shape.shapeKey,
      slots: [],
      infill,
      infillVariants,
    };
  }

  // Residential: lay out slots using the template.
  const template = TEMPLATE_BY_KEY[shape.shapeKey];
  const slots: PlannedSlot[] = [];
  const taken = new Set<string>();
  if (template) {
    const assignments = shape.assignments;
    const count = Math.min(assignments.length, template.slots.length);
    for (let i = 0; i < count; i++) {
      const local = template.slots[i]!;
      const tile = { x: inner.x0 + local.x, y: inner.y0 + local.y };
      slots.push({ local, tile, category: assignments[i]! });
      taken.add(`${tile.x},${tile.y}`);
    }
  }

  const infill: TilePos[] = [];
  const infillVariants: string[] = [];
  for (let y = inner.y0; y <= inner.y1; y++) {
    for (let x = inner.x0; x <= inner.x1; x++) {
      if (!taken.has(`${x},${y}`)) {
        infill.push({ x, y });
        infillVariants.push('pavement');
      }
    }
  }

  return {
    id,
    kind: 'residential',
    inner,
    shapeKey: shape.shapeKey,
    slots,
    infill,
    infillVariants,
  };
}

// ----------------------------------------------------------------------------
// Road rings.
//
// For every district we emit the ring of tiles one step outside the inner
// rect. Shared tiles between adjacent districts are deduped so a single
// `Road.tiles` array covers the whole network. All road tiles are emitted
// as a single `street` path — the renderer classifies them by neighbor
// mask (straight / corner / T / +) so no arterial/street distinction is
// needed here.
// ----------------------------------------------------------------------------

function buildRoadRings(
  districts: readonly PlannedDistrict[],
  grid: GridSize,
): Road[] {
  const seen = new Set<string>();
  const innerTiles = new Set<string>();
  for (const d of districts) {
    for (let y = d.inner.y0; y <= d.inner.y1; y++) {
      for (let x = d.inner.x0; x <= d.inner.x1; x++) {
        innerTiles.add(`${x},${y}`);
      }
    }
  }

  const tiles: TilePos[] = [];
  for (const d of districts) {
    for (let x = d.inner.x0 - 1; x <= d.inner.x1 + 1; x++) {
      pushRing(x, d.inner.y0 - 1);
      pushRing(x, d.inner.y1 + 1);
    }
    for (let y = d.inner.y0; y <= d.inner.y1; y++) {
      pushRing(d.inner.x0 - 1, y);
      pushRing(d.inner.x1 + 1, y);
    }
  }

  function pushRing(x: number, y: number) {
    if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return;
    const k = `${x},${y}`;
    if (seen.has(k)) return;
    if (innerTiles.has(k)) return;
    seen.add(k);
    tiles.push({ x, y });
  }

  if (tiles.length === 0) return [];
  return [{ class: 'street', tiles }];
}
