import { describe, expect, test } from 'bun:test';
import {
  createMask,
  getBit,
  markFootprint,
} from '../src/grid.js';
import { aStar } from '../src/roads.js';
import { generateWorld } from '../src/world-gen.js';
import { rankAll } from '../src/ranker.js';

const GRID = { w: 24, h: 24 };

// ============================================================================
// A* on a clean mask — pathfinding primitive used by the sim.
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
// World-gen integration: the BSP carver populates `world.roads` with tagged
// strips whose tile lists survive generation.
// ============================================================================

describe('roads in generated world', () => {
  test('generateWorld populates roads with class + tiles', () => {
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
    for (const road of w.roads) {
      expect(['arterial', 'street']).toContain(road.class);
      expect(Array.isArray(road.tiles)).toBe(true);
      expect(road.tiles.length).toBeGreaterThan(0);
      // Tiles must be inside the generation grid.
      for (const t of road.tiles) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThan(w.grid.w);
        expect(t.y).toBeLessThan(w.grid.h);
      }
    }
  });

  test('road network is non-empty once districts are present', () => {
    const commits = [];
    for (let i = 0; i < 30; i++) {
      commits.push({
        sha: `c${i}`,
        message: `feat: ${i}`,
        authorLogin: 'a',
        authoredAt: new Date(2024, 0, 1 + i).toISOString(),
        additions: 100,
        deletions: 10,
        changedFiles: [`src/f${i}.ts`],
      });
    }
    const ranked = rankAll(commits);
    const w = generateWorld({ fullName: 'alice/big', totalCommits: 5000 }, ranked);
    const totalTiles = w.roads.reduce((s, r) => s + r.tiles.length, 0);
    expect(totalTiles).toBeGreaterThan(0);
  });
});
