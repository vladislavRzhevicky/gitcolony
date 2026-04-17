<!--
  Roads — modular road-tile GLBs from Kenney's Starter Kit City Builder.

  Tile type is picked from the 4-neighbor occupancy mask across every path
  in world.roads. Rotation is derived from the same mask so geometry lines
  up with neighbouring tiles.

  Lamps aren't a separate prop in this pack — a baked-in variant of the
  straight tile (road-straight-lightposts.glb) carries twin lampposts on
  its verges. Every Nth straight along the run axis picks that variant,
  giving a rhythmic lamppost cadence without the placement math needed
  for freestanding lamp GLBs.

  Starter Kit native orientations (established empirically — see the
  calibration constants in classifyTile):
    - road-straight:     runs E<->W (along X).
    - road-corner:       rounded bend, connects W + S natively.
    - road-intersection: T-junction, closed edge facing N natively.
    - road-split:        true 4-way crossroad (starter-kit filenames lie
                         — `split` is the crossroad, `intersection` is
                         the T).

  If visual inspection shows seams misaligned, tweak the per-type base
  rotations in classifyTile — no change needed in the asset registry.
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

  interface TileInstance {
    id: string;
    scene: Object3D;
    x: number;
    z: number;
    rotationY: number;
    scale: number;
  }

  let instances = $state<TileInstance[]>([]);

  $effect(() => {
    let cancelled = false;
    instances = [];

    const occ = new Set<string>();
    for (const path of world.roads) {
      for (const t of path.tiles) occ.add(tileKey(t));
    }

    const visited = new Set<string>();
    const queue: { tile: TilePos; key: string }[] = [];
    const enqueue = (t: TilePos) => {
      const k = tileKey(t);
      if (visited.has(k)) return;
      visited.add(k);
      queue.push({ tile: t, key: k });
    };
    for (const path of world.roads) {
      for (const t of path.tiles) enqueue(t);
    }

    Promise.all(
      queue.map(async ({ tile, key }) => {
        const { url, rotationY } = classifyTile(tile, occ);
        const [scene, extent] = await Promise.all([cloneTemplate(url), templateExtent(url)]);
        // Starter-kit road tiles are native 1×1×Y in their own units but
        // fit-to-TILE_SIZE keeps us kit-agnostic — if a future variant
        // ships at a different intrinsic size the seams still line up.
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
        } satisfies TileInstance;
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

  function popcount4(m: number): number {
    return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
  }

  // Every Nth tile along a straight's run axis swaps to the lit variant.
  // Keyed by position on the strip (not by order visited) so long runs
  // get evenly spaced lamps regardless of which end the ring crawler
  // started at; 4 keeps 25% of straights lit — dense enough to read as
  // a city, sparse enough to avoid a pole-to-pole chain.
  const LAMPPOST_PERIOD = 4;

  type Classified = { url: string; rotationY: number };

  /**
   * Classify a tile by its neighbor mask and return the GLB URL plus a Y
   * rotation (radians) that aligns the model's default orientation to the
   * actual neighbor layout.
   *
   * Rotation convention: a right angle is PI/2. We count rotations
   * clockwise looking down the +Y axis — three.js's *negative* Y rotation
   * by the right-hand rule, so `QUARTER = -PI/2` is one CW step.
   */
  export function classifyTile(t: TP, occ: Set<string>): Classified {
    const m = neighborMask(t, occ);
    const n = popcount4(m);
    const QUARTER = -Math.PI / 2;

    // Isolated and fully connected tiles — use the crossroad silhouette
    // for both. Isolated reads as a neutral plaza cap; 4-way is literal.
    if (n === 0 || n === 4) return { url: ROAD_MODELS.intersection, rotationY: 0 };

    if (n === 1) {
      // Dead-end. Cap with a fountain plaza — a bare straight stub past the
      // last connected neighbor reads as a broken road, the fountain reads
      // as a deliberate terminus. Symmetric, no rotation needed.
      return { url: ROAD_MODELS.deadEnd, rotationY: 0 };
    }

    if (n === 3) {
      // T-junction. road-intersection.glb has the closed edge facing N in
      // its native orientation — rotate `missingIdx` quarter-turns so that
      // closed side lines up with whichever neighbor this tile is missing.
      const missing = ~m & 0b1111;
      const missingIdx = maskToSingleDir(missing);
      return { url: ROAD_MODELS.split, rotationY: missingIdx * QUARTER };
    }

    // n === 2 — either straight or bend. Native straight runs N<->S.
    if (m === 0b1010) return { url: straightUrlAt(t, false), rotationY: Math.PI / 2 };
    if (m === 0b0101) return { url: straightUrlAt(t, true), rotationY: 0 };

    // Adjacent pair — bend. Native road-corner connects W + S (mask 0b1100).
    // Each CW quarter-turn advances both legs one direction clockwise.
    const BEND_ROT: Record<number, number> = {
      0b1100: 0,             // W+S (native)
      0b1001: QUARTER,       // N+W
      0b0011: QUARTER * 2,   // E+N
      0b0110: QUARTER * 3,   // S+E
    };
    const rot = BEND_ROT[m];
    return { url: ROAD_MODELS.corner, rotationY: rot ?? 0 };
  }

  // Pick the plain or lit straight based on position along the run axis.
  // Using the coordinate on the strip (not across it) keeps spacing
  // visually consistent across ring + interior strips — both share the
  // same modulo cadence and lamps line up between blocks.
  function straightUrlAt(t: TP, vertical: boolean): string {
    const along = vertical ? t.y : t.x;
    const lit = ((along % LAMPPOST_PERIOD) + LAMPPOST_PERIOD) % LAMPPOST_PERIOD === 0;
    return lit ? ROAD_MODELS.straightLit : ROAD_MODELS.straight;
  }

  function maskToSingleDir(m: number): number {
    for (let i = 0; i < 4; i++) if (m & (1 << i)) return i;
    return 0;
  }
</script>
