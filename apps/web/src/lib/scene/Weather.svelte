<!--
  Weather — procedural, texture-free atmospheric layer.

  Four modes, all built from primitives + three.js:
    - sun    → nothing extra; upstream lighting stays warm (no fog).
    - clouds → a field of low-poly sphere-puff clusters drifting on wind;
               soft gray scene fog.
    - rain   → darker cloud field + THREE.Points rain streaks falling
               through the city volume; stronger fog.
    - storm  → densest clouds, heavier/faster rain, periodic lightning
               flashes added to ambient; heavy desaturated fog.

  Everything is bounded by the cityBounds passed from ColonyScene so the
  weather follows the populated area regardless of repo size. Tick work
  runs in Threlte's task graph alongside the agent sim — no external RAF.

  Determinism: cloud layout hashes off (world.seed, cloudCount) so the
  same repo always generates the same sky silhouette for a given mode.
  Rain is pure transient noise (doesn't need determinism).

  Presentation-only: never writes to the world, sim, or schema. Safe to
  unmount or swap mode at any frame.
-->
<script lang="ts" module>
  export type WeatherMode = 'sun' | 'clouds' | 'rain' | 'storm';
</script>

<script lang="ts">
  import { T, useTask, useThrelte } from '@threlte/core';
  import {
    BufferAttribute,
    BufferGeometry,
    Color,
    FogExp2,
    Points,
    PointsMaterial,
  } from 'three';

  interface Bounds {
    cx: number;
    cz: number;
    width: number;
    depth: number;
    maxDim: number;
  }

  interface Props {
    mode: WeatherMode;
    bounds: Bounds;
    seed?: number;
  }

  let { mode, bounds, seed = 1 }: Props = $props();

  // Deterministic PRNG (mulberry32). Same seed → same cloud field.
  function mulberry32(a: number) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Per-mode knobs. Keeping all variation in one table makes it trivial
  // to retune later without hunting through the render code.
  // cloudFlat: y-squash applied to puff offsets + radii so sun-mode
  // cirrus read as wispy streaks instead of cumulus blobs. 1 = normal
  // puff shape, <1 = flatter, longer.
  const PALETTE = {
    sun: {
      cloudColor: '#ffffff',
      cloudOpacity: 0.85,
      cloudCount: 4,
      cloudFlat: 0.22,
      rainCount: 0,
      rainColor: '#ffffff',
      rainSize: 0,
      // Density is overridden below with a size-relative formula so the
      // horizon haze stays consistent across colony sizes — this number
      // is unused for `sun`. Color is picked to match the Preetham sky
      // near the horizon at elevation 2° under ACES + exposure 0.5, so
      // the sea's far edge fades into the sunset gradient.
      fogDensity: 0,
      fogColor: '#c89a82',
      lightning: false,
    },
    clouds: {
      cloudColor: '#f3f5f8',
      cloudOpacity: 0.92,
      cloudCount: 14,
      cloudFlat: 1,
      rainCount: 0,
      rainColor: '#ffffff',
      rainSize: 0,
      fogDensity: 0.004,
      fogColor: '#c8d0da',
      lightning: false,
    },
    rain: {
      cloudColor: '#7e8894',
      cloudOpacity: 0.94,
      cloudCount: 18,
      cloudFlat: 1,
      rainCount: 1800,
      rainColor: '#b4cfe3',
      rainSize: 0.14,
      fogDensity: 0.009,
      fogColor: '#7c8795',
      lightning: false,
    },
    storm: {
      cloudColor: '#3d444f',
      cloudOpacity: 0.96,
      cloudCount: 22,
      cloudFlat: 1,
      rainCount: 3200,
      rainColor: '#9fb6cb',
      rainSize: 0.18,
      fogDensity: 0.015,
      fogColor: '#4a525e',
      lightning: true,
    },
  } as const;

  const p = $derived(PALETTE[mode]);

  // ---- Clouds -----------------------------------------------------------
  // A cloud is a handful of overlapping spheres at slightly varied radii
  // arranged in a flattened blob — reads as "low-poly puff" against the
  // sky at any camera angle without needing a billboarded sprite.
  interface Puff { x: number; y: number; z: number; r: number; }
  interface Cloud {
    id: number;
    cx: number;
    cz: number;
    cy: number;
    drift: number;
    puffs: Puff[];
  }

  const clouds = $derived.by<Cloud[]>(() => {
    const count = p.cloudCount;
    const rng = mulberry32(seed + count * 101);
    const span = bounds.maxDim * 1.6;
    // Sun-mode cirrus sit higher and spread wider — they're thin streaks
    // decorating the sky rather than a cumulus field near ground.
    const hiSky = p.cloudFlat < 0.5;
    const flat = p.cloudFlat;
    // Base puff size in world units. Cumulus puffs (overcast/rain/storm)
    // sit low and stay small; cirrus (sun) must scale with the colony
    // or they shrink to invisible dots on big maps.
    const sizeBase = hiSky ? bounds.maxDim * 0.09 : 2;
    const sizeVar  = hiSky ? bounds.maxDim * 0.08 : 2.5;
    const result: Cloud[] = [];
    for (let i = 0; i < count; i++) {
      const cx = bounds.cx + (rng() - 0.5) * span;
      const cz = bounds.cz + (rng() - 0.5) * span;
      // Heights are tuned against the default ColonyScene camera tilt
      // (look-down ~42°, FOV 35°). Anything above ~maxDim * 0.65 sits
      // above the visible frustum at default zoom, so cirrus live in a
      // lower band than cumulus despite being conceptually higher —
      // otherwise they only appear when the user dollies far out.
      const cy = bounds.maxDim * (hiSky ? 0.35 + rng() * 0.15 : 0.45 + rng() * 0.25);
      const size = sizeBase + rng() * sizeVar;
      const puffCount = 4 + Math.floor(rng() * 5);
      const puffs: Puff[] = [];
      for (let j = 0; j < puffCount; j++) {
        // Horizontal stretch factor lengthens flat clouds without
        // making cumulus blobs lopsided (stretch = 1 for non-flat).
        const stretch = hiSky ? 1.8 : 1;
        puffs.push({
          x: (rng() - 0.5) * size * 2.4 * stretch,
          y: (rng() - 0.5) * size * 0.6 * flat,
          z: (rng() - 0.5) * size * 1.6,
          r: size * (0.65 + rng() * 0.55),
        });
      }
      result.push({ id: i, cx, cz, cy, drift: 0.4 + rng() * 0.6, puffs });
    }
    return result;
  });

  // Cirrus get a non-uniform Y-scale on the whole group so the spheres
  // themselves flatten into lenticular shapes. Cheaper than swapping
  // geometry for an ellipsoid per puff.
  const cloudGroupScaleY = $derived(p.cloudFlat);

  // Wind clock. Drives both cloud drift and rain horizontal shear so the
  // two effects feel coherent. Reads `mode` for intensity.
  let windTime = $state(0);
  const windSpeed = $derived(
    mode === 'storm' ? 2.6
    : mode === 'rain' ? 1.3
    : mode === 'clouds' ? 0.55
    : mode === 'sun' ? 0.2
    : 0,
  );
  const wrapSpan = $derived(bounds.maxDim * 1.6);

  // Wrap cloud X into [cx - span/2, cx + span/2] so clouds recycle on the
  // windward edge instead of drifting to infinity.
  function cloudX(c: Cloud): number {
    if (wrapSpan <= 0) return c.cx;
    const offset = c.drift * windTime * windSpeed;
    const rel =
      (((c.cx - bounds.cx + offset) % wrapSpan) + wrapSpan * 1.5) % wrapSpan -
      wrapSpan / 2;
    return bounds.cx + rel;
  }

  // ---- Rain -------------------------------------------------------------
  // Single Points mesh = single draw call for thousands of streaks.
  // Rebuilt on mode change (count/size/color differ); mutated per-frame
  // for fall + wind shear.
  interface RainState {
    obj: Points;
    geom: BufferGeometry;
    mat: PointsMaterial;
    velocities: Float32Array;
    topY: number;
    span: number;
  }
  let rainState = $state<RainState | null>(null);

  $effect(() => {
    const count = p.rainCount;
    if (count === 0) {
      rainState = null;
      return;
    }
    const rng = mulberry32(seed + 7 + count);
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count);
    const span = bounds.maxDim * 1.2;
    const topY = bounds.maxDim * 0.9;
    for (let i = 0; i < count; i++) {
      positions[i * 3 + 0] = bounds.cx + (rng() - 0.5) * span;
      positions[i * 3 + 1] = rng() * topY;
      positions[i * 3 + 2] = bounds.cz + (rng() - 0.5) * span;
      velocities[i] = 30 + rng() * 40;
    }
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(positions, 3));
    const mat = new PointsMaterial({
      color: new Color(p.rainColor),
      size: p.rainSize,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const obj = new Points(geom, mat);
    rainState = { obj, geom, mat, velocities, topY, span };
    return () => {
      geom.dispose();
      mat.dispose();
      rainState = null;
    };
  });

  // ---- Lightning --------------------------------------------------------
  // Additive ambient pulse. Peak ~2x normal ambient, decays in <200ms —
  // short enough to read as a flash rather than a fade-to-white.
  let flashIntensity = $state(0);
  let flashRemain = 0;
  let flashCooldown = 3 + Math.random() * 4;

  // ---- Per-frame tick ---------------------------------------------------
  useTask((delta) => {
    windTime += delta;

    // Rain fall + wind shear + recycle at ground.
    if (rainState) {
      const { geom, velocities, topY, span } = rainState;
      const pos = geom.getAttribute('position') as BufferAttribute;
      const arr = pos.array as Float32Array;
      const fallMul = mode === 'storm' ? 1.4 : 1;
      const shear = windSpeed * 0.6 * delta;
      for (let i = 0; i < velocities.length; i++) {
        arr[i * 3 + 1] -= velocities[i] * delta * fallMul;
        arr[i * 3 + 0] += shear;
        if (arr[i * 3 + 1] < 0) {
          arr[i * 3 + 1] = topY;
          arr[i * 3 + 0] = bounds.cx + (Math.random() - 0.5) * span;
          arr[i * 3 + 2] = bounds.cz + (Math.random() - 0.5) * span;
        }
      }
      pos.needsUpdate = true;
    }

    // Lightning schedule. Only active under `storm` palette.
    if (!p.lightning) {
      if (flashIntensity !== 0) flashIntensity = 0;
      flashRemain = 0;
      return;
    }
    if (flashRemain > 0) {
      flashRemain -= delta;
      flashIntensity = Math.max(0, flashRemain / 0.18) * 2.2;
      if (flashRemain <= 0) {
        flashIntensity = 0;
        flashCooldown = 3 + Math.random() * 6;
      }
      return;
    }
    flashCooldown -= delta;
    if (flashCooldown <= 0) {
      flashRemain = 0.18 + Math.random() * 0.12;
    }
  });

  // ---- Scene fog --------------------------------------------------------
  // Mutate scene.fog directly — attaching fog as a child of a group is
  // awkward in Threlte since fog belongs to Scene, not the object graph.
  //
  // `sun` mode uses a size-relative density so the warm horizon haze
  // that hides the sea/sky seam has the same feel on tiny and huge
  // colonies. FogExp2 is exponential in absolute world units; anchoring
  // the e^-1 distance to `maxDim * 6` means the sea edge (plane runs
  // ~6 × maxDim from center) fades to ~37% visibility, while the city
  // itself (~1 × maxDim away) stays around 85% crisp. Overcast modes
  // keep their hand-tuned absolute densities — they're not trying to
  // blend a horizon so size scaling adds no value there.
  const fogDensity = $derived(
    mode === 'sun'
      ? 1 / Math.max(bounds.maxDim * 6, 1)
      : p.fogDensity,
  );

  const { scene } = useThrelte();
  $effect(() => {
    const prev = scene.fog;
    scene.fog = fogDensity > 0 ? new FogExp2(p.fogColor, fogDensity) : null;
    return () => {
      scene.fog = prev;
    };
  });
</script>

<!-- Lightning flash — additive ambient pulse on top of the base rig. -->
{#if p.lightning}
  <T.AmbientLight intensity={flashIntensity} color="#dfe9ff" />
{/if}

<!-- Cloud field. Wind moves the Group; puffs are static relative to it.
     Group-level Y-scale squashes cirrus into lenticular streaks while
     leaving cumulus puffs spherical. -->
{#each clouds as c (c.id)}
  <T.Group position={[cloudX(c), c.cy, c.cz]} scale={[1, cloudGroupScaleY, 1]}>
    {#each c.puffs as puff, pi (pi)}
      <T.Mesh position={[puff.x, puff.y, puff.z]}>
        <T.SphereGeometry args={[puff.r, 6, 5]} />
        <T.MeshStandardMaterial
          color={p.cloudColor}
          flatShading
          transparent={p.cloudOpacity < 1}
          opacity={p.cloudOpacity}
          roughness={1}
        />
      </T.Mesh>
    {/each}
  </T.Group>
{/each}

<!-- Rain. Entire Points object is pre-built — mount it via `is={}`. -->
{#if rainState}
  <T is={rainState.obj} />
{/if}
