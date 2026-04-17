import { describe, expect, test } from 'bun:test';
import {
  FOOTPRINT_BUILDING_2x1,
  FOOTPRINT_DECOR_1x1,
  absoluteFootprint,
  buildOccupiedMask,
  buildWalkableMask,
  createMask,
  districtBBox,
  findPlacement,
  getBit,
  inBounds,
  isFootprintFree,
  markFootprint,
  setBit,
} from '../src/grid.js';
import { createRng } from '../src/seed.js';
import type { District, WorldObject } from '@gitcolony/schema';

const GRID = { w: 16, h: 16 };

describe('mask primitives', () => {
  test('new mask is all free', () => {
    const m = createMask(GRID);
    for (let y = 0; y < GRID.h; y++) {
      for (let x = 0; x < GRID.w; x++) {
        expect(getBit(m, x, y)).toBe(0);
      }
    }
  });

  test('out-of-bounds reads as occupied', () => {
    const m = createMask(GRID);
    expect(getBit(m, -1, 0)).toBe(1);
    expect(getBit(m, 0, -1)).toBe(1);
    expect(getBit(m, GRID.w, 0)).toBe(1);
    expect(getBit(m, 0, GRID.h)).toBe(1);
    expect(inBounds(m, -1, 0)).toBe(false);
    expect(inBounds(m, GRID.w, 0)).toBe(false);
  });

  test('setBit/getBit roundtrip', () => {
    const m = createMask(GRID);
    setBit(m, 3, 5, 1);
    expect(getBit(m, 3, 5)).toBe(1);
    setBit(m, 3, 5, 0);
    expect(getBit(m, 3, 5)).toBe(0);
  });

  test('markFootprint covers all tiles', () => {
    const m = createMask(GRID);
    const tiles = absoluteFootprint({ x: 2, y: 3 }, FOOTPRINT_BUILDING_2x1);
    markFootprint(m, tiles, 1);
    expect(getBit(m, 2, 3)).toBe(1);
    expect(getBit(m, 3, 3)).toBe(1);
    expect(getBit(m, 4, 3)).toBe(0);
  });

  test('isFootprintFree respects bounds and occupancy', () => {
    const m = createMask(GRID);
    setBit(m, 5, 5, 1);
    expect(isFootprintFree(m, [{ x: 5, y: 5 }])).toBe(false);
    expect(isFootprintFree(m, [{ x: 4, y: 5 }])).toBe(true);
    // escapes grid
    expect(isFootprintFree(m, [{ x: GRID.w, y: 0 }])).toBe(false);
  });
});

describe('districtBBox', () => {
  const d: District = {
    id: 'd-x',
    name: 'x',
    isOutskirts: false,
    isGraveyard: false,
    center: { x: 8, y: 8 },
    blocks: [{ x0: 5, y0: 6, x1: 10, y1: 9 }],
    theme: 'generic',
  };

  test('bbox matches the sole block rectangle', () => {
    const b = districtBBox(d, GRID);
    expect(b).toEqual({ x0: 5, y0: 6, x1: 10, y1: 9 });
  });

  test('bbox unions multiple blocks (L-shape districts)', () => {
    const multi: District = {
      ...d,
      blocks: [
        { x0: 2, y0: 2, x1: 5, y1: 5 },
        { x0: 6, y0: 4, x1: 9, y1: 7 },
      ],
    };
    const b = districtBBox(multi, GRID);
    expect(b).toEqual({ x0: 2, y0: 2, x1: 9, y1: 7 });
  });

  test('bbox clamps to grid edges', () => {
    const b = districtBBox(
      { ...d, blocks: [{ x0: -3, y0: -3, x1: 2, y1: 2 }] },
      GRID,
    );
    expect(b.x0).toBe(0);
    expect(b.y0).toBe(0);
  });
});

describe('findPlacement', () => {
  const bbox = { x0: 2, y0: 2, x1: 5, y1: 5 };

  test('finds a free anchor for decor inside bbox', () => {
    const m = createMask(GRID);
    const rng = createRng('t-decor');
    const anchor = findPlacement(m, bbox, FOOTPRINT_DECOR_1x1, rng);
    expect(anchor).not.toBeNull();
    expect(anchor!.x).toBeGreaterThanOrEqual(2);
    expect(anchor!.x).toBeLessThanOrEqual(5);
    expect(anchor!.y).toBeGreaterThanOrEqual(2);
    expect(anchor!.y).toBeLessThanOrEqual(5);
  });

  test('building fits only where both tiles are inside bbox', () => {
    const m = createMask(GRID);
    const rng = createRng('t-build');
    const anchor = findPlacement(m, bbox, FOOTPRINT_BUILDING_2x1, rng);
    expect(anchor).not.toBeNull();
    // second tile (anchor.x + 1) must also be inside bbox.x1
    expect(anchor!.x + 1).toBeLessThanOrEqual(bbox.x1);
  });

  test('returns null when bbox is fully occupied', () => {
    const m = createMask(GRID);
    for (let y = bbox.y0; y <= bbox.y1; y++) {
      for (let x = bbox.x0; x <= bbox.x1; x++) setBit(m, x, y, 1);
    }
    const rng = createRng('t-full');
    expect(findPlacement(m, bbox, FOOTPRINT_DECOR_1x1, rng)).toBeNull();
  });

  test('returns null when bbox is smaller than footprint', () => {
    const tinyBBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
    const rng = createRng('t-tiny');
    expect(findPlacement(createMask(GRID), tinyBBox, FOOTPRINT_BUILDING_2x1, rng)).toBeNull();
  });

  test('deterministic for same rng seed', () => {
    const m = createMask(GRID);
    const a = findPlacement(m, bbox, FOOTPRINT_DECOR_1x1, createRng('same'));
    const b = findPlacement(m, bbox, FOOTPRINT_DECOR_1x1, createRng('same'));
    expect(a).toEqual(b);
  });

  test('fills the full bbox without collisions when called repeatedly', () => {
    const m = createMask(GRID);
    const rng = createRng('t-fill');
    const bboxArea = (bbox.x1 - bbox.x0 + 1) * (bbox.y1 - bbox.y0 + 1);
    const placed = new Set<string>();
    for (let i = 0; i < bboxArea; i++) {
      const a = findPlacement(m, bbox, FOOTPRINT_DECOR_1x1, rng);
      expect(a).not.toBeNull();
      const key = `${a!.x},${a!.y}`;
      expect(placed.has(key)).toBe(false);
      placed.add(key);
      markFootprint(m, [a!], 1);
    }
    expect(placed.size).toBe(bboxArea);
    // Next call must fail — bbox saturated.
    expect(findPlacement(m, bbox, FOOTPRINT_DECOR_1x1, rng)).toBeNull();
  });
});

describe('buildOccupiedMask / buildWalkableMask', () => {
  const objects: WorldObject[] = [
    {
      id: 'obj-a',
      commitSha: 'a',
      tier: 'B',
      kind: 'building',
      variant: 'house-01',
      districtId: 'd-x',
      anchor: { x: 3, y: 3 },
      footprint: [{ x: 3, y: 3 }, { x: 4, y: 3 }],
    },
    {
      id: 'obj-b',
      commitSha: 'b',
      tier: 'C',
      kind: 'decor',
      variant: 'tree-01',
      districtId: 'd-x',
      anchor: { x: 7, y: 7 },
      footprint: [{ x: 7, y: 7 }],
    },
  ];

  test('occupied mask marks every footprint tile', () => {
    const m = buildOccupiedMask(GRID, objects);
    expect(getBit(m, 3, 3)).toBe(1);
    expect(getBit(m, 4, 3)).toBe(1);
    expect(getBit(m, 7, 7)).toBe(1);
    expect(getBit(m, 0, 0)).toBe(0);
  });

  test('walkable mask is the inverse', () => {
    const w = buildWalkableMask(GRID, objects);
    expect(getBit(w, 3, 3)).toBe(0);
    expect(getBit(w, 4, 3)).toBe(0);
    expect(getBit(w, 7, 7)).toBe(0);
    expect(getBit(w, 0, 0)).toBe(1);
    expect(getBit(w, 5, 3)).toBe(1);
  });
});
