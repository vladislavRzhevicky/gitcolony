<!--
  Roads — modular road-tile GLBs from Kenney City Kit Roads.

  Each tile's type (straight / bend / T / cross / end / square) is picked
  from its 4-neighbor occupancy in the union of every path in world.roads.
  Rotation is derived from the same mask so the geometry lines up with
  neighboring tiles.

  Kenney tile conventions assumed (based on City Kit Roads 1.0):
    - road-straight: runs along X (connects W<->E).
    - road-bend:     connects N+E (rotate to other bends).
    - road-end:      open end faces +X (E); rotate so the "closed" end
                     points away from the single neighbor.
    - road-intersection: T with missing edge on -X (W); rotate.
    - road-crossroad: symmetric, any rotation works.
    - road-square:   isolated pad.

  If visual inspection shows seams misaligned, tweak the per-type base
  rotations here — no change needed in the registry.
-->
<script lang="ts">
  import { T } from '@threlte/core';
  import type { Object3D } from 'three';
  import type { TilePos, World } from '@gitcolony/schema';
  import { cloneTemplate, templateExtent } from './gltf';
  import { TILE_SIZE, tileToWorld } from './mapping';

  interface Props {
    world: World;
  }
  let { world }: Props = $props();

  interface RoadInstance {
    id: string;
    scene: Object3D;
    x: number;
    z: number;
    rotationY: number;
    scale: number;
  }

  let instances = $state<RoadInstance[]>([]);

  $effect(() => {
    let cancelled = false;
    instances = [];

    // Union of every road path, keyed by "x,y", so we can query neighbors
    // without caring which path a tile came from.
    const occ = new Set<string>();
    for (const path of world.roads) {
      for (const t of path) occ.add(tileKey(t));
    }

    // Visit each occupied tile exactly once — paths often overlap at
    // intersections and we don't want duplicate meshes stacked on top.
    const visited = new Set<string>();
    const queue: { tile: TilePos; key: string }[] = [];
    const enqueue = (t: TilePos) => {
      const k = tileKey(t);
      if (visited.has(k)) return;
      visited.add(k);
      queue.push({ tile: t, key: k });
    };
    for (const path of world.roads) {
      for (const t of path) enqueue(t);
    }

    // Ring road — visual-only perimeter wrapping the city, one tile outside
    // the bbox of every existing road strip. This lets every interior strip
    // T-intersect the ring instead of dead-ending at the district edge, so
    // `road-end` caps disappear naturally (corners become bends, straight
    // segments along the ring stay straight, strips meeting the ring read
    // as intersections). Pure scene augmentation — core/layout is untouched.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const path of world.roads) {
      for (const t of path) {
        if (t.x < minX) minX = t.x;
        if (t.x > maxX) maxX = t.x;
        if (t.y < minY) minY = t.y;
        if (t.y > maxY) maxY = t.y;
      }
    }
    if (Number.isFinite(minX)) {
      const rMinX = minX - 1;
      const rMaxX = maxX + 1;
      const rMinY = minY - 1;
      const rMaxY = maxY + 1;
      for (let x = rMinX; x <= rMaxX; x++) {
        const top = { x, y: rMinY };
        const bot = { x, y: rMaxY };
        occ.add(tileKey(top));
        occ.add(tileKey(bot));
        enqueue(top);
        enqueue(bot);
      }
      for (let y = rMinY + 1; y < rMaxY; y++) {
        const left = { x: rMinX, y };
        const right = { x: rMaxX, y };
        occ.add(tileKey(left));
        occ.add(tileKey(right));
        enqueue(left);
        enqueue(right);
      }
    }

    Promise.all(
      queue.map(async ({ tile, key }) => {
        const { type, rotationY } = classifyTile(tile, occ);
        const url = ROAD_MODELS[type];
        const [scene, extent] = await Promise.all([cloneTemplate(url), templateExtent(url)]);
        // Rescale so the tile's XZ footprint equals TILE_SIZE × TILE_SIZE.
        // Kenney road tiles ship at various intrinsic sizes (often 2 units
        // per tile); this normalises to our grid regardless of pack.
        const maxExtent = Math.max(extent.x, extent.z);
        const scale = maxExtent > 0 ? TILE_SIZE / maxExtent : 1;
        const p = tileToWorld(tile, world.grid, 0.01);
        return {
          id: key,
          scene,
          x: p.x,
          z: p.z,
          rotationY,
          scale,
        } satisfies RoadInstance;
      }),
    ).then((resolved) => {
      if (!cancelled) instances = resolved;
    });

    return () => {
      cancelled = true;
    };
  });
</script>

{#each instances as r (r.id)}
  <T.Group
    position={[r.x, 0.01, r.z]}
    rotation={[0, r.rotationY, 0]}
    scale={[r.scale, r.scale, r.scale]}
  >
    <T is={r.scene} />
  </T.Group>
{/each}

<script lang="ts" module>
  import type { TilePos as TP } from '@gitcolony/schema';
  import { ROAD_MODELS } from './assets';
  type RM = typeof ROAD_MODELS;

  export function tileKey(t: TP): string {
    return `${t.x},${t.y}`;
  }

  // Four neighbors with a fixed order: N (-y), E (+x), S (+y), W (-x).
  // The bitmask lets us reason about tile types with simple integer math
  // and map directly onto rotation counts.
  const DIRS = [
    { dx: 0, dy: -1 }, // N  bit 0
    { dx: 1, dy: 0 },  // E  bit 1
    { dx: 0, dy: 1 },  // S  bit 2
    { dx: -1, dy: 0 }, // W  bit 3
  ];

  function neighborMask(t: TP, occ: Set<string>): number {
    let m = 0;
    for (let i = 0; i < DIRS.length; i++) {
      const d = DIRS[i]!;
      if (occ.has(`${t.x + d.dx},${t.y + d.dy}`)) m |= 1 << i;
    }
    return m;
  }

  // Number of set bits in a 4-bit mask.
  function popcount4(m: number): number {
    return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
  }

  /**
   * Classify a tile by its neighbor mask and return the model type plus
   * a Y rotation (radians) that aligns the GLB's default orientation to
   * the actual neighbor layout.
   *
   * Rotation math: a right angle is PI/2. We count rotations clockwise
   * looking down the +Y axis — which in three.js is *negative* Y rotation
   * (right-hand rule). Calibration constants (BASE_ROT) capture the
   * default orientation of each Kenney model.
   */
  export function classifyTile(
    t: TP,
    occ: Set<string>,
  ): { type: keyof RM; rotationY: number } {
    const m = neighborMask(t, occ);
    const n = popcount4(m);
    const QUARTER = -Math.PI / 2; // one clockwise step when looking down

    if (n === 0) return { type: 'square', rotationY: 0 };

    if (n === 4) return { type: 'crossroad', rotationY: 0 };

    if (n === 1) {
      // Single neighbor — would be a dead end. We explicitly avoid the
      // `road-end` cap (user preference: no stubs) and render a straight
      // segment oriented along the neighbor axis instead. The strip reads
      // as if it continues offscreen rather than being plugged shut. In
      // practice the ring road added in Roads.svelte eliminates n===1
      // cases; this branch is kept as a safety net.
      const dirIdx = maskToSingleDir(m);
      // dirIdx 0 (N) or 2 (S) => vertical neighbor => straight along Z.
      // dirIdx 1 (E) or 3 (W) => horizontal neighbor => straight along X.
      const vertical = dirIdx === 0 || dirIdx === 2;
      return { type: 'straight', rotationY: vertical ? Math.PI / 2 : 0 };
    }

    if (n === 3) {
      // T-junction — 'intersection'. Default: missing edge on W (bit 3).
      // Find which direction is missing and rotate accordingly.
      const missing = (~m) & 0b1111;
      const missingIdx = maskToSingleDir(missing);
      // Default missing edge index = 3 (W). Rotate so actual missing dir
      // lands on index 3. Empirical +PI/2 calibration offset: Kenney's
      // road-intersection.glb actually has the missing edge on S in its
      // native orientation, not W — without the offset all T-junctions
      // face a quarter-turn off.
      return {
        type: 'intersection',
        rotationY: (missingIdx - 3) * QUARTER + Math.PI / 2,
      };
    }

    // n === 2 — either straight or bend.
    // Opposite pairs: N+S (0b0101) or E+W (0b1010).
    if (m === 0b0101) return { type: 'straight', rotationY: Math.PI / 2 };
    if (m === 0b1010) return { type: 'straight', rotationY: 0 };

    // Adjacent pair — bend. Default connects N+E. Each QUARTER step
    // advances both legs one direction clockwise (N→E→S→W→N), giving four
    // possible masks. Straight lookup — a naive "lowest set bit" returns
    // the wrong CW-first for the wrap-around W+N pair (N is lowest but W
    // is the CW-first of the pair).
    const BEND_ROT: Record<number, number> = {
      0b0011: 0, // N+E
      0b0110: 1, // E+S
      0b1100: 2, // S+W
      0b1001: 3, // W+N
    };
    const k = BEND_ROT[m] ?? 0;
    // Empirical +PI calibration: road-bend.glb's native orientation is
    // S+W, not N+E, so every bend needs a 180° correction on top of the
    // mask-driven rotation.
    return { type: 'bend', rotationY: k * QUARTER + Math.PI };
  }

  function maskToSingleDir(m: number): number {
    for (let i = 0; i < 4; i++) if (m & (1 << i)) return i;
    return 0;
  }
</script>
