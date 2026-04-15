import type { District, RankedCommit, TilePos } from '@gitcolony/schema';
import { topLevel } from './ranker.js';
import type { GridSize } from './grid.js';

// ============================================================================
// District layout — proximity graph + topology + force-directed placement.
//
// Pure, deterministic, seed-driven. Replaces the ring-only stub in world-gen.
// Strategy:
//   1. Extract top-level dirs co-touched per commit -> weighted edge graph.
//   2. Pick a topology hint from district count (line/ring/cluster).
//   3. Seed initial positions per topology, then relax with Fruchterman-
//      Reingold. Short run, quantized to tiles, clamped to grid.
//   4. Enforce minimum separation so district bboxes don't overlap.
// ============================================================================

export type Topology = 'single' | 'line' | 'ring' | 'cluster';

export interface ProximityGraph {
  /** Adjacency: name -> neighbor -> co-touch commit count. Symmetric. */
  edges: Map<string, Map<string, number>>;
  /** Number of commits that touched each dir. */
  weight: Map<string, number>;
}

// ----------------------------------------------------------------------------
// Proximity graph from commit history
// ----------------------------------------------------------------------------

export function buildProximityGraph(
  ranked: readonly RankedCommit[],
  depth = 1,
): ProximityGraph {
  const edges = new Map<string, Map<string, number>>();
  const weight = new Map<string, number>();

  for (const c of ranked) {
    const dirs = new Set<string>();
    for (const f of c.changedFiles) {
      const t = topLevel(f, depth);
      if (t) dirs.add(t);
    }
    for (const d of dirs) weight.set(d, (weight.get(d) ?? 0) + 1);

    const arr = Array.from(dirs).sort();
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        addEdge(edges, arr[i]!, arr[j]!);
      }
    }
  }
  return { edges, weight };
}

function addEdge(
  edges: Map<string, Map<string, number>>,
  a: string,
  b: string,
): void {
  bump(edges, a, b);
  bump(edges, b, a);
}

function bump(
  edges: Map<string, Map<string, number>>,
  a: string,
  b: string,
): void {
  let row = edges.get(a);
  if (!row) {
    row = new Map();
    edges.set(a, row);
  }
  row.set(b, (row.get(b) ?? 0) + 1);
}

// ----------------------------------------------------------------------------
// Topology choice
// ----------------------------------------------------------------------------

export function chooseTopology(districtCount: number): Topology {
  if (districtCount <= 1) return 'single';
  if (districtCount <= 3) return 'line';
  if (districtCount <= 6) return 'ring';
  return 'cluster';
}

// ----------------------------------------------------------------------------
// Initial positions per topology
// ----------------------------------------------------------------------------

type Vec2 = { x: number; y: number };

function initialPositions(
  names: readonly string[],
  topo: Topology,
  center: Vec2,
  radius: number,
  rng: () => number,
): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  const n = names.length;
  if (n === 0) return out;

  switch (topo) {
    case 'single': {
      out.set(names[0]!, { ...center });
      return out;
    }
    case 'line': {
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        out.set(names[i]!, {
          x: center.x + (t - 0.5) * 2 * radius,
          y: center.y,
        });
      }
      return out;
    }
    case 'ring': {
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * Math.PI * 2;
        out.set(names[i]!, {
          x: center.x + Math.cos(angle) * radius,
          y: center.y + Math.sin(angle) * radius,
        });
      }
      return out;
    }
    case 'cluster': {
      // Random jitter around center so force sim has something to work with.
      for (const name of names) {
        const a = rng() * Math.PI * 2;
        const r = rng() * radius;
        out.set(name, { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r });
      }
      return out;
    }
  }
}

// ----------------------------------------------------------------------------
// Force-directed relaxation — Fruchterman-Reingold, short bounded run.
// ----------------------------------------------------------------------------

interface ForceArgs {
  names: readonly string[];
  edges: Map<string, Map<string, number>>;
  initial: Map<string, Vec2>;
  bounds: { x0: number; y0: number; x1: number; y1: number };
  iterations?: number;
}

function relax({
  names,
  edges,
  initial,
  bounds,
  iterations = 80,
}: ForceArgs): Map<string, Vec2> {
  const n = names.length;
  if (n <= 1) return new Map(initial);

  const area = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0);
  const k = Math.sqrt(area / n);
  const pos = new Map<string, Vec2>();
  for (const name of names) {
    const p = initial.get(name)!;
    pos.set(name, { x: p.x, y: p.y });
  }

  let temperature = Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0) / 10;
  const cool = temperature / iterations;

  for (let iter = 0; iter < iterations; iter++) {
    const disp = new Map<string, Vec2>();
    for (const name of names) disp.set(name, { x: 0, y: 0 });

    // Repulsion between every pair.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = names[i]!;
        const b = names[j]!;
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const d = Math.max(0.01, Math.hypot(dx, dy));
        const force = (k * k) / d;
        const ux = dx / d;
        const uy = dy / d;
        const da = disp.get(a)!;
        const db = disp.get(b)!;
        da.x += ux * force;
        da.y += uy * force;
        db.x -= ux * force;
        db.y -= uy * force;
      }
    }

    // Attraction along edges, scaled by weight.
    for (const a of names) {
      const row = edges.get(a);
      if (!row) continue;
      const pa = pos.get(a)!;
      for (const [b, w] of row) {
        if (!pos.has(b)) continue;
        // Each edge visited twice (symmetric); halve contribution.
        const pb = pos.get(b)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const d = Math.max(0.01, Math.hypot(dx, dy));
        const force = ((d * d) / k) * Math.log2(1 + w) * 0.5;
        const ux = dx / d;
        const uy = dy / d;
        const da = disp.get(a)!;
        da.x -= ux * force;
        da.y -= uy * force;
      }
    }

    // Apply displacements with temperature clamp + bounds.
    for (const name of names) {
      const p = pos.get(name)!;
      const d = disp.get(name)!;
      const mag = Math.max(0.01, Math.hypot(d.x, d.y));
      const cap = Math.min(mag, temperature);
      p.x = clamp(p.x + (d.x / mag) * cap, bounds.x0, bounds.x1);
      p.y = clamp(p.y + (d.y / mag) * cap, bounds.y0, bounds.y1);
    }
    temperature = Math.max(0.1, temperature - cool);
  }

  return pos;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ----------------------------------------------------------------------------
// Post-pass: shove overlapping district bboxes apart until separated.
// ----------------------------------------------------------------------------

function enforceSeparation(
  names: readonly string[],
  pos: Map<string, Vec2>,
  minDist: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  maxPasses = 30,
): void {
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i]!;
        const b = names[j]!;
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const d = Math.hypot(dx, dy);
        if (d >= minDist) continue;
        const push = (minDist - d) / 2 + 0.5;
        // Handle exactly-overlapping case with a deterministic nudge.
        const nx = d < 0.01 ? 1 : dx / d;
        const ny = d < 0.01 ? 0 : dy / d;
        pa.x = clamp(pa.x + nx * push, bounds.x0, bounds.x1);
        pa.y = clamp(pa.y + ny * push, bounds.y0, bounds.y1);
        pb.x = clamp(pb.x - nx * push, bounds.x0, bounds.x1);
        pb.y = clamp(pb.y - ny * push, bounds.y0, bounds.y1);
        moved = true;
      }
    }
    if (!moved) return;
  }
}

// ----------------------------------------------------------------------------
// Public: full district layout
// ----------------------------------------------------------------------------

const DISTRICT_THEME = 'generic';

export interface LayoutInput {
  ranked: readonly RankedCommit[];
  grid: GridSize;
  districtSize: GridSize;
  rng: () => number;
  /** Path depth used to derive district names from changed files. */
  pathDepth?: number;
}

export function layoutDistricts({
  ranked,
  grid,
  districtSize,
  rng,
  pathDepth = 1,
}: LayoutInput): District[] {
  const graph = buildProximityGraph(ranked, pathDepth);

  // District set = union of every top-level dir that appears as primaryPath
  // OR as a co-touched dir in the graph. A dir that's always a secondary
  // touch (e.g. `tests/` co-changing with `src/`, but never primary due to
  // tie-breaking) still deserves its own place on the map.
  const names = new Set<string>();
  for (const c of ranked) if (c.primaryPath) names.add(c.primaryPath);
  for (const d of graph.weight.keys()) names.add(d);
  const sortedNames = Array.from(names).sort();

  const districts: District[] = [];

  // Invariant #3: outskirts always exists, pinned at NW corner.
  districts.push({
    id: 'd-outskirts',
    name: 'outskirts',
    isOutskirts: true,
    center: { x: Math.ceil(districtSize.w / 2), y: Math.ceil(districtSize.h / 2) },
    sizeInTiles: districtSize,
    theme: DISTRICT_THEME,
  });

  if (sortedNames.length === 0) return districts;

  const topology = chooseTopology(sortedNames.length);

  // Bounds: district centers must be placeable such that bbox fits grid.
  const halfW = Math.floor(districtSize.w / 2);
  const halfH = Math.floor(districtSize.h / 2);
  const bounds = {
    x0: halfW,
    y0: halfH,
    x1: grid.w - halfW - 1,
    y1: grid.h - halfH - 1,
  };

  // Skew center away from outskirts so non-outskirts districts don't crowd it.
  const center = {
    x: (bounds.x0 + bounds.x1) / 2 + (bounds.x1 - bounds.x0) * 0.1,
    y: (bounds.y0 + bounds.y1) / 2 + (bounds.y1 - bounds.y0) * 0.1,
  };
  const radius = Math.min(bounds.x1 - center.x, bounds.y1 - center.y) * 0.75;

  const initial = initialPositions(sortedNames, topology, center, radius, rng);
  const relaxed = relax({ names: sortedNames, edges: graph.edges, initial, bounds });

  // Separation = diagonal of district bbox — guarantees no bbox overlap.
  const minSep = Math.hypot(districtSize.w, districtSize.h);
  enforceSeparation(sortedNames, relaxed, minSep, bounds);

  for (const name of sortedNames) {
    const p = relaxed.get(name)!;
    districts.push({
      id: `d-${slugify(name)}`,
      name,
      isOutskirts: false,
      center: { x: Math.round(p.x), y: Math.round(p.y) },
      sizeInTiles: districtSize,
      theme: DISTRICT_THEME,
    });
  }

  return districts;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
}

// ----------------------------------------------------------------------------
// Grid-pack arrangement
//
// Districts are tiled in a near-square grid, each cell sized to districtSize
// and separated by a road of `roadWidth` tiles. Used in place of the
// force-directed layout so the city reads as a tight settlement crossed by
// streets rather than detached islands floating in green space.
// ----------------------------------------------------------------------------

export interface ArrangementInput {
  ranked: readonly RankedCommit[];
  grid: GridSize;
  districtSize: GridSize;
  pathDepth?: number;
  /** Tiles between adjacent district pads — these become the road grid. */
  roadWidth?: number;
}

export interface Arrangement {
  districts: District[];
  /** Each row/column of road tiles laid in the gaps between districts. */
  roads: TilePos[][];
}

export function arrangeCity({
  ranked,
  grid,
  districtSize,
  pathDepth = 1,
  roadWidth = 1,
}: ArrangementInput): Arrangement {
  // Collect the district names — same logic as the legacy layout, just so
  // we end up with one district per primaryPath plus the outskirts fallback.
  const graph = buildProximityGraph(ranked, pathDepth);
  const names = new Set<string>();
  for (const c of ranked) if (c.primaryPath) names.add(c.primaryPath);
  for (const d of graph.weight.keys()) names.add(d);
  const sortedNames = Array.from(names).sort();

  // Outskirts is always present and sits in the last cell of the grid so it
  // tends to land at a corner — visually distinct without special-casing.
  const cellNames = [...sortedNames, '__outskirts__'];
  const n = cellNames.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));

  const cellW = districtSize.w + roadWidth;
  const cellH = districtSize.h + roadWidth;
  // Total city dims (in tiles), without trailing road gap.
  const cityW = cols * cellW - roadWidth;
  const cityH = rows * cellH - roadWidth;
  // Origin so the whole city is centered on the grid.
  const ox = Math.floor((grid.w - cityW) / 2);
  const oy = Math.floor((grid.h - cityH) / 2);

  const districts: District[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x0 = ox + col * cellW;
    const y0 = oy + row * cellH;
    const center: TilePos = {
      x: x0 + Math.floor(districtSize.w / 2),
      y: y0 + Math.floor(districtSize.h / 2),
    };
    const isOutskirts = cellNames[i] === '__outskirts__';
    districts.push({
      id: isOutskirts ? 'd-outskirts' : `d-${slugify(cellNames[i]!)}`,
      name: isOutskirts ? 'outskirts' : cellNames[i]!,
      isOutskirts,
      center,
      sizeInTiles: districtSize,
      theme: 'generic',
    });
  }

  // Roads = horizontal strips between rows + vertical strips between columns,
  // each `roadWidth` tiles thick, spanning the full city footprint.
  const roads: TilePos[][] = [];
  for (let r = 1; r < rows; r++) {
    const yStart = oy + r * cellH - roadWidth;
    for (let dy = 0; dy < roadWidth; dy++) {
      const y = yStart + dy;
      const strip: TilePos[] = [];
      for (let x = ox; x < ox + cityW; x++) strip.push({ x, y });
      roads.push(strip);
    }
  }
  for (let c = 1; c < cols; c++) {
    const xStart = ox + c * cellW - roadWidth;
    for (let dx = 0; dx < roadWidth; dx++) {
      const x = xStart + dx;
      const strip: TilePos[] = [];
      for (let y = oy; y < oy + cityH; y++) strip.push({ x, y });
      roads.push(strip);
    }
  }

  return { districts, roads };
}
