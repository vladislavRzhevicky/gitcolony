import { describe, expect, test } from 'bun:test';
import type { District, TilePos } from '@gitcolony/schema';
import {
  createMask,
  getBit,
  markFootprint,
} from '../src/grid.js';
import { createRng } from '../src/seed.js';
import { aStar, planRoads } from '../src/roads.js';
import { generateWorld } from '../src/world-gen.js';
import { rankAll } from '../src/ranker.js';

const GRID = { w: 24, h: 24 };

function district(id: string, x: number, y: number, outskirts = false): District {
  return {
    id,
    name: id.replace(/^d-/, ''),
    isOutskirts: outskirts,
    center: { x, y },
    sizeInTiles: { w: 6, h: 6 },
    theme: 'generic',
  };
}

// ============================================================================
// A* on a clean mask
// ============================================================================

describe('aStar basics', () => {
  test('returns a contiguous path between two tiles on an empty grid', () => {
    const m = createMask(GRID);
    const path = aStar(m, { x: 2, y: 3 }, { x: 10, y: 8 });
    expect(path).not.toBeNull();
    const p = path!;
    expect(p[0]).toEqual({ x: 2, y: 3 });
    expect(p[p.length - 1]).toEqual({ x: 10, y: 8 });
    // Each step moves to a 4-neighbor, no diagonals, no gaps.
    for (let i = 1; i < p.length; i++) {
      const dx = Math.abs(p[i]!.x - p[i - 1]!.x);
      const dy = Math.abs(p[i]!.y - p[i - 1]!.y);
      expect(dx + dy).toBe(1);
    }
  });

  test('path never enters blocked tiles and stays inside the grid', () => {
    const m = createMask(GRID);
    // Carve a wall with a single gap — forces a detour.
    for (let y = 0; y < 10; y++) markFootprint(m, [{ x: 8, y }], 1);
    const path = aStar(m, { x: 2, y: 2 }, { x: 15, y: 2 });
    expect(path).not.toBeNull();
    for (const t of path!) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(GRID.w);
      expect(t.y).toBeLessThan(GRID.h);
      // occupied tiles must not appear on the path (except goal, which is free here).
      expect(getBit(m, t.x, t.y)).toBe(0);
    }
  });

  test('returns null when the goal is unreachable', () => {
    const m = createMask(GRID);
    // Seal (20, 20) behind a full wall.
    for (let x = 0; x < GRID.w; x++) markFootprint(m, [{ x, y: 19 }], 1);
    for (let y = 19; y < GRID.h; y++) markFootprint(m, [{ x: 19, y }], 1);
    expect(aStar(m, { x: 0, y: 0 }, { x: 22, y: 22 })).toBeNull();
  });

  test('deterministic: same inputs produce identical path', () => {
    const m = createMask(GRID);
    const a = aStar(m, { x: 1, y: 1 }, { x: 18, y: 18 });
    const b = aStar(m, { x: 1, y: 1 }, { x: 18, y: 18 });
    expect(a).toEqual(b);
  });
});

// ============================================================================
// planRoads: graph-level behavior
// ============================================================================

describe('planRoads', () => {
  const occupied = createMask(GRID);

  test('every path endpoint is the center of a district', () => {
    const districts: District[] = [
      district('d-outskirts', 4, 4, true),
      district('d-a', 12, 6),
      district('d-b', 18, 14),
      district('d-c', 6, 18),
    ];
    const roads = planRoads({
      districts,
      occupied,
      grid: GRID,
      rng: createRng('seed-1'),
    });
    expect(roads.length).toBeGreaterThan(0);
    const centers = new Set(districts.map((d) => `${d.center.x},${d.center.y}`));
    for (const path of roads) {
      const head = path[0]!;
      const tail = path[path.length - 1]!;
      expect(centers.has(`${head.x},${head.y}`)).toBe(true);
      expect(centers.has(`${tail.x},${tail.y}`)).toBe(true);
    }
  });

  test('graph is connected (every non-outskirts reaches outskirts)', () => {
    const districts: District[] = [
      district('d-outskirts', 3, 3, true),
      district('d-a', 12, 5),
      district('d-b', 20, 12),
      district('d-c', 18, 20),
      district('d-d', 6, 18),
    ];
    const roads = planRoads({
      districts,
      occupied,
      grid: GRID,
      rng: createRng('seed-connected'),
    });

    // Build an adjacency set over district ids from the road endpoints.
    const adj = new Map<string, Set<string>>();
    for (const d of districts) adj.set(d.id, new Set());
    for (const path of roads) {
      const a = findDistrictAt(districts, path[0]!);
      const b = findDistrictAt(districts, path[path.length - 1]!);
      expect(a && b).toBeTruthy();
      adj.get(a!.id)!.add(b!.id);
      adj.get(b!.id)!.add(a!.id);
    }
    // BFS from outskirts.
    const reached = new Set<string>(['d-outskirts']);
    const queue = ['d-outskirts'];
    while (queue.length > 0) {
      const n = queue.shift()!;
      for (const m of adj.get(n) ?? []) {
        if (!reached.has(m)) {
          reached.add(m);
          queue.push(m);
        }
      }
    }
    for (const d of districts) expect(reached.has(d.id)).toBe(true);
  });

  test('paths do not cross pre-placed object footprints', () => {
    // Block a ring of tiles around each district center except a small gap;
    // A* must route around them.
    const mask = createMask(GRID);
    const blocked: TilePos[] = [];
    // Place a blob of obstacles between two district centers.
    for (let y = 8; y <= 12; y++) {
      for (let x = 10; x <= 14; x++) blocked.push({ x, y });
    }
    markFootprint(mask, blocked, 1);

    const districts: District[] = [
      district('d-outskirts', 2, 2, true),
      district('d-a', 6, 6),
      district('d-b', 20, 18),
    ];
    const roads = planRoads({
      districts,
      occupied: mask,
      grid: GRID,
      rng: createRng('seed-obstacles'),
    });
    expect(roads.length).toBeGreaterThan(0);
    const blockedSet = new Set(blocked.map((t) => `${t.x},${t.y}`));
    const centers = new Set(districts.map((d) => `${d.center.x},${d.center.y}`));
    for (const path of roads) {
      for (const t of path) {
        const key = `${t.x},${t.y}`;
        // An obstacle may happen to sit on a district center; that's allowed
        // (road can terminate there). Otherwise no blocked tile is touched.
        if (centers.has(key)) continue;
        expect(blockedSet.has(key)).toBe(false);
      }
    }
  });

  test('deterministic: same rng seed yields identical roads', () => {
    const districts: District[] = [
      district('d-outskirts', 4, 4, true),
      district('d-a', 12, 6),
      district('d-b', 18, 14),
      district('d-c', 6, 18),
    ];
    const a = planRoads({
      districts,
      occupied,
      grid: GRID,
      rng: createRng('same-seed'),
    });
    const b = planRoads({
      districts,
      occupied,
      grid: GRID,
      rng: createRng('same-seed'),
    });
    expect(a).toEqual(b);
  });

  test('every path tile stays inside the grid', () => {
    const districts: District[] = [
      district('d-outskirts', 2, 2, true),
      district('d-a', 21, 3),
      district('d-b', 3, 21),
      district('d-c', 21, 21),
    ];
    const roads = planRoads({
      districts,
      occupied,
      grid: GRID,
      rng: createRng('seed-bounds'),
    });
    for (const path of roads) {
      for (const t of path) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThan(GRID.w);
        expect(t.y).toBeLessThan(GRID.h);
      }
    }
  });
});

function findDistrictAt(
  districts: readonly District[],
  t: TilePos,
): District | undefined {
  return districts.find((d) => d.center.x === t.x && d.center.y === t.y);
}

// ============================================================================
// World-gen integration: roads land on the World and survive extend.
// ============================================================================

describe('roads in generated world', () => {
  test('generateWorld populates roads array', () => {
    const ranked = rankAll([
      {
        sha: 's1',
        message: 'feat: a',
        authorLogin: 'a',
        authoredAt: '2024-01-01T00:00:00Z',
        additions: 10,
        deletions: 0,
        changedFiles: ['src/a.ts'],
      },
      {
        sha: 's2',
        message: 'docs: b',
        authorLogin: 'a',
        authoredAt: '2024-01-02T00:00:00Z',
        additions: 10,
        deletions: 0,
        changedFiles: ['docs/b.md'],
      },
    ]);
    const w = generateWorld({ fullName: 'alice/roads' }, ranked);
    expect(Array.isArray(w.roads)).toBe(true);
    expect(w.roads.length).toBeGreaterThan(0);
  });
});
