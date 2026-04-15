<!--
  Island — hex-tile terrain that surrounds the square city grid.

  Concept: the city sits on a flat platform; everything beyond the
  populated district pads is a honeycomb of Kenney Hexagon Kit tiles
  forming an irregular island that fades into water. This replaces the
  old infinite green plane (see CLAUDE.md in this folder) so the city
  reads as "a settlement on an island" instead of "a square in a void".

  Layout:
    - Inside cityBounds → no hex tiles (city plane + district pads cover
      this rect; we don't want hexes peeking through gaps).
    - Annulus around cityBounds → grass / grass-forest / grass-hill,
      picked by deterministic noise so each colony has its own foliage.
    - Outer ring → sand (beach).
    - Beyond beach → water hex slabs.
    - Past the last water hex → an infinite dark-blue sea plane handles
      the horizon.

  Determinism: every per-tile choice (variant, vertical jitter, ring
  cutoff offset) hashes from `(world.seed, qx, qy)` so the same repo
  always grows the same coastline. Pure visual layer — no schema
  changes, no @gitcolony/core involvement.
-->
<script lang="ts">
  import { T } from '@threlte/core';
  import type { Object3D } from 'three';
  import type { World } from '@gitcolony/schema';
  import { cloneTemplate, templateExtent } from './gltf';

  interface Bounds {
    cx: number;
    cz: number;
    width: number;
    depth: number;
    maxDim: number;
  }

  interface Props {
    world: World;
    bounds: Bounds;
  }

  let { world, bounds }: Props = $props();

  // Hex pack URLs — match files copied by scripts/copy-assets.sh into
  // /static/models/terrain/. Tile types are intentionally limited to the
  // ones used here; expanding the palette is a copy-assets edit + a
  // mention in TIER_VARIANTS below.
  const HEX = {
    grass: '/models/terrain/grass.glb',
    grassForest: '/models/terrain/grass-forest.glb',
    grassHill: '/models/terrain/grass-hill.glb',
    sand: '/models/terrain/sand.glb',
    sandRocks: '/models/terrain/sand-rocks.glb',
    stoneHill: '/models/terrain/stone-hill.glb',
    stoneMountain: '/models/terrain/stone-mountain.glb',
    water: '/models/terrain/water.glb',
    waterRocks: '/models/terrain/water-rocks.glb',
  } as const;

  // Per-tier variant pool. We sub-pick a variant via a second noise
  // channel so e.g. the grass band has occasional forest/hill clumps
  // without us hand-placing them.
  const TIER_VARIANTS = {
    grass: [HEX.grass, HEX.grass, HEX.grass, HEX.grassForest, HEX.grassHill, HEX.stoneHill],
    sand: [HEX.sand, HEX.sand, HEX.sandRocks],
    water: [HEX.water, HEX.water, HEX.water, HEX.waterRocks],
    mountain: [HEX.stoneMountain, HEX.stoneHill],
  } as const;

  type Tier = keyof typeof TIER_VARIANTS;

  interface HexInstance {
    id: string;
    scene: Object3D;
    x: number;
    z: number;
    y: number;
    scale: number;
  }

  let instances = $state<HexInstance[]>([]);

  // Tunables, in world units (TILE_SIZE = 1 grid tile = 1 world unit).
  // HEX_FLAT controls visual chunkiness — too small and the island looks
  // pixelated; too large and the coastline can't be irregular enough to
  // hide its grid origin. 1.6 reads well for a 48x48 grid city.
  const HEX_FLAT = 1.6; // flat-to-flat width of one hex tile, in world units
  const RING_GRASS = 8; // grass band thickness past city edge
  const RING_SAND = 3;  // beach band thickness
  const RING_WATER = 5; // water band thickness
  const NOISE_AMP = 2.5; // ±world units of jitter on band boundaries

  // Kenney Hexagon Kit flat tiles (grass / sand) are 0.2 tall in native
  // units. Scaled by HEX_FLAT, their slab height becomes 0.2 × HEX_FLAT.
  // We lower the island so the TOP of a flat grass tile sits at Y = 0 —
  // flush with the city platform plane, so the city grass, district pads
  // and hex grass all read as one continuous ground. Water drops a bit
  // further so the coast still reads as a cliff.
  const LAND_SLAB = 0.2 * HEX_FLAT;     // scaled native grass/sand height
  const LAND_BASE_Y = -LAND_SLAB;        // → land tops at Y = 0
  const COAST_DROP = 0.22;               // world units water sits below land tops
  const WATER_SLAB = 0.1 * HEX_FLAT;     // scaled native water slab height
  const WATER_BASE_Y = -COAST_DROP - WATER_SLAB; // → water tops at Y = -COAST_DROP

  $effect(() => {
    let cancelled = false;
    instances = [];

    const seed = world.seed;
    // Plan honeycomb extent: cover bounds + (grass + sand + water) ring
    // plus a small buffer so noise can't push tiles outside the tile pool.
    const ringTotal = RING_GRASS + RING_SAND + RING_WATER + NOISE_AMP * 2;
    const halfW = bounds.width / 2 + ringTotal;
    const halfD = bounds.depth / 2 + ringTotal;

    // Pointy-top honeycomb — Kenney Hexagon Kit ships tiles with
    // flat-to-flat along X (1.0 in native units) and corner-to-corner
    // along Z (2/√3 ≈ 1.1547). So the honeycomb step is `flat` across
    // columns, `3/4 × corner` down rows, and odd rows get shifted by
    // half a flat width along X.
    const corner = HEX_FLAT * 2 / Math.sqrt(3);
    const stepX = HEX_FLAT;
    const stepZ = corner * 0.75;

    const cols = Math.ceil((halfW * 2) / stepX) + 2;
    const rows = Math.ceil((halfD * 2) / stepZ) + 2;
    const x0 = bounds.cx - (cols / 2) * stepX;
    const z0 = bounds.cz - (rows / 2) * stepZ;

    interface Plan {
      key: string;
      url: string;
      x: number;
      z: number;
      y: number;
    }
    const plans: Plan[] = [];

    for (let q = 0; q < cols; q++) {
      for (let r = 0; r < rows; r++) {
        // Pointy-top: offset odd rows (not columns) by half a step X.
        const wx = x0 + q * stepX + (r % 2 === 0 ? 0 : stepX / 2);
        const wz = z0 + r * stepZ;
        const tier = pickTier(wx, wz, bounds, seed);
        if (!tier) continue;
        const pool = TIER_VARIANTS[tier];
        const url = pool[hash32(`${seed}:v:${q}:${r}`) % pool.length]!;
        // Grass / sand / mountain sit with their tops flush to Y = 0 so
        // the city platform and the island read as one continuous
        // surface. Water drops by COAST_DROP so the coast still reads
        // as a visible cliff.
        const yBase = tier === 'water' ? WATER_BASE_Y : LAND_BASE_Y;
        // Tiny downward-only jitter on land so flat plots don't look
        // like a poured slab. Negative-only so nothing pokes above the
        // city platform at Y = 0. Water stays flat — a surface.
        const jitter = tier === 'water' ? 0 : -rand01(seed, q, r) * 0.03;
        plans.push({
          key: `${q},${r}`,
          url,
          x: wx,
          z: wz,
          y: yBase + jitter,
        });
      }
    }

    // Group by url so we measure each template once, not per-instance.
    const byUrl = new Map<string, Plan[]>();
    for (const p of plans) {
      const list = byUrl.get(p.url) ?? [];
      list.push(p);
      byUrl.set(p.url, list);
    }

    Promise.all(
      Array.from(byUrl.entries()).map(async ([url, list]) => {
        const extent = await templateExtent(url);
        // Scale so the tile's flat-to-flat dimension matches HEX_FLAT.
        // Kenney hex tiles are flat-top with native flat ≈ 1; we measure
        // the smaller XZ extent to handle any pack-specific quirks.
        const native = Math.min(extent.x, extent.z);
        const scale = native > 0 ? HEX_FLAT / native : 1;
        // Each placement gets its own clone — sharing one Object3D
        // would let three.js render only the last position.
        return Promise.all(
          list.map(async (p) => {
            const scene = await cloneTemplate(url);
            return {
              id: p.key,
              scene,
              x: p.x,
              z: p.z,
              y: p.y,
              scale,
            } satisfies HexInstance;
          }),
        );
      }),
    ).then((groups) => {
      if (!cancelled) instances = groups.flat();
    });

    return () => {
      cancelled = true;
    };
  });

  // Distance-from-cityBounds → tier. Negative inside city (skipped),
  // grass / sand / water rings outside, plus a chance of mountain
  // outcrops in the outer grass band so the silhouette isn't all flat.
  function pickTier(wx: number, wz: number, b: Bounds, seed: string): Tier | null {
    const dx = Math.abs(wx - b.cx);
    const dz = Math.abs(wz - b.cz);
    const halfW = b.width / 2;
    const halfD = b.depth / 2;
    // Distance outside the city rect (Chebyshev-ish — feels like a square
    // platform with rounded corners after the noise pass).
    const outX = Math.max(0, dx - halfW);
    const outZ = Math.max(0, dz - halfD);
    const baseDist = Math.hypot(outX, outZ);
    if (baseDist === 0) return null;

    const wobble = (rand01(seed, Math.round(wx * 3.7), Math.round(wz * 3.7)) - 0.5) * NOISE_AMP * 2;
    const d = baseDist + wobble;

    if (d < RING_GRASS) {
      // Sprinkle mountain outcrops in the outer half of the grass band.
      const mountainRoll = rand01(seed, Math.round(wx * 1.9), Math.round(wz * 2.3));
      if (d > RING_GRASS * 0.55 && mountainRoll < 0.06) return 'mountain';
      return 'grass';
    }
    if (d < RING_GRASS + RING_SAND) return 'sand';
    if (d < RING_GRASS + RING_SAND + RING_WATER) return 'water';
    return null;
  }

  // Stable [0, 1) noise from any (seed, x, y) triple. Cheap FNV-1a — we
  // don't need spatial coherence, just reproducibility.
  function rand01(seed: string, x: number, y: number): number {
    return hash32(`${seed}:${x}:${y}`) / 0xffffffff;
  }

  function hash32(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
</script>

{#each instances as h (h.id)}
  <T.Group
    position={[h.x, h.y, h.z]}
    scale={[h.scale, h.scale, h.scale]}
  >
    <T is={h.scene} />
  </T.Group>
{/each}
