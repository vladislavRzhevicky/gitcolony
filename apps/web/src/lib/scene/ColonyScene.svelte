<!--
  ColonyScene — orchestrates the 3D view of a generated world.

  Composes camera, lighting, ground, and the four asset-driven layers:
    - Buildings   (tier-B commits as Kenney City Kit GLBs)
    - Roads       (Kenney City Kit Roads tiles, oriented by neighbor mask)
    - Scenery     (tier-C/D decor + road-side props from Nature Kit)
    - Agents      (Blocky Characters moved by AgentSim)

  Picking is funnelled through a single onPick prop so the page-level
  panel doesn't care which layer the click originated from.
-->
<script lang="ts" module>
  export type CameraMode = 'orbit' | 'pan';

  export interface CameraApi {
    zoomIn(): void;
    zoomOut(): void;
    reset(): void;
    setMode(mode: CameraMode): void;
  }
</script>

<script lang="ts">
  import { T, useTask, useThrelte } from '@threlte/core';
  import { OrbitControls } from '@threlte/extras';
  import { ACESFilmicToneMapping, Color, MOUSE } from 'three';
  import type { OrbitControls as ThreeOrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
  import Buildings from './Buildings.svelte';
  import Roads from './Roads.svelte';
  import Scenery from './Scenery.svelte';
  import Agents from './Agents.svelte';
  import Island from './Island.svelte';
  import Sky from './Sky.svelte';
  import Weather, { type WeatherMode } from './Weather.svelte';
  import {
    COLORS,
    TILE_SIZE,
    tileToWorld,
    type Picked,
    type World,
  } from './mapping';
  import type { AgentSim } from './sim.svelte';

  interface Props {
    world: World;
    // Owned by the page — same instance is passed to ChatPanel so both
    // render surfaces observe the same chat log and AI roster. ColonyScene
    // only advances it via useTask (must live inside <Canvas>).
    sim: AgentSim;
    // Presentation-only. Drives the Weather layer + swaps light presets
    // below. Defaults to `sun` so existing callers don't need to opt in.
    weather?: WeatherMode;
    onPick?: (picked: Picked) => void;
    onReady?: (api: CameraApi) => void;
  }

  let { world, sim, weather = 'sun', onPick, onReady }: Props = $props();

  // Lighting responds to weather. Cloud/rain/storm desaturate the sun and
  // pull ambient toward cool gray so buildings/agents read as overcast
  // without touching their materials. Shadows stay on across modes — they
  // just get softer via the lower directional intensity.
  const LIGHT_PRESETS: Record<
    WeatherMode,
    { amb: number; ambColor: string; dir: number; dirColor: string }
  > = {
    // Sun values are tuned against ACES tone mapping + exposure 0.8 so
    // the Kenney palette reads saturated and the scene feels sunny
    // rather than dusk-muted. Overcast rigs stay dimmer by design.
    sun:    { amb: 0.9,  ambColor: '#fff1d8', dir: 2.1,  dirColor: '#fff2cc' },
    clouds: { amb: 0.55, ambColor: '#d6dde5', dir: 0.7,  dirColor: '#dfe4ea' },
    rain:   { amb: 0.45, ambColor: '#aab5c2', dir: 0.38, dirColor: '#c5cdd5' },
    storm:  { amb: 0.3,  ambColor: '#626f7d', dir: 0.2,  dirColor: '#8b95a3' },
  };
  const light = $derived(LIGHT_PRESETS[weather]);

  // Tone-mapping exposure per weather. The three.js sky example uses
  // 0.5 because its scene is a grid — here most of the frame is city /
  // island, so sun can breathe at 0.8 without blowing out the sky.
  // Overcast modes stay low so rain/storm keep their muted punch.
  const EXPOSURE: Record<WeatherMode, number> = {
    sun: 0.8,
    clouds: 0.55,
    rain: 0.45,
    storm: 0.35,
  };

  // Sky shader presets. `sun` matches the canonical threejs.org
  // webgl_shaders_sky example verbatim — turbidity 10 / rayleigh 3 /
  // elevation 2° / azimuth 180° under ACES tone mapping + exposure 0.5
  // gives the golden-hour sunset gradient with the sun disc right on
  // the horizon. Overcast modes damp rayleigh (blue scattering) and
  // push turbidity so the sky reads as muted haze behind the Weather
  // cloud field. Storm additionally crushes the sun with high mie.
  const SKY_PRESETS: Record<
    WeatherMode,
    {
      turbidity: number;
      rayleigh: number;
      mieCoefficient: number;
      mieDirectionalG: number;
      elevation: number;
      azimuth: number;
    }
  > = {
    sun:    { turbidity: 10, rayleigh: 3,   mieCoefficient: 0.005, mieDirectionalG: 0.7, elevation: 2,  azimuth: 180 },
    clouds: { turbidity: 14, rayleigh: 1,   mieCoefficient: 0.02,  mieDirectionalG: 0.7, elevation: 20, azimuth: 180 },
    rain:   { turbidity: 18, rayleigh: 0.4, mieCoefficient: 0.04,  mieDirectionalG: 0.6, elevation: 15, azimuth: 180 },
    storm:  { turbidity: 20, rayleigh: 0.2, mieCoefficient: 0.08,  mieDirectionalG: 0.5, elevation: 10, azimuth: 180 },
  };
  const sky = $derived(SKY_PRESETS[weather]);

  // Hash world.seed (string) → uint32 for the Weather layer's PRNG.
  // djb2: cheap, non-crypto, consistent across sessions for the same repo.
  const weatherSeed = $derived.by(() => {
    let h = 5381;
    for (let i = 0; i < world.seed.length; i++) {
      h = (h * 33) ^ world.seed.charCodeAt(i);
    }
    return h >>> 0;
  });

  useTask((delta) => sim.tick(delta));

  // ACES tone mapping + a weather-driven exposure is required for the
  // Sky shader to read as a proper atmosphere — without ACES the
  // Preetham output blows out into a flat pale gradient. Exposure
  // tracks the weather mode so sunny feels sunny (0.8) while rain /
  // storm stay muted (0.35–0.45). `toneMappingExposure` isn't exposed
  // as a Canvas prop in Threlte 8, so we reach for the renderer
  // directly; `toneMapping` goes through the Threlte context so
  // Threlte's own change tracking picks it up.
  const ctx = useThrelte();
  $effect(() => {
    ctx.toneMapping.set(ACESFilmicToneMapping);
    ctx.renderer.toneMappingExposure = EXPOSURE[weather];
  });

  // Per-weather platform tint. The platform renders with an unlit Basic
  // material (no way around that — it needs to exactly match the Kenney
  // colormap-sampled green of the hex tiles under sun, and giving it a
  // GLB material breaks because the hex material is UV-sampled against a
  // palette atlas). Under non-sun weather the hex tiles (Standard + fog)
  // darken while an unlit platform would stay bright; we approximate the
  // same darkening here by multiplying the base color toward the fog
  // tint per mode. Not physically correct but visually the seam closes.
  const PLATFORM_TINT: Record<
    WeatherMode,
    { mul: number; mix: string; mixAmount: number }
  > = {
    sun:    { mul: 1.0,  mix: '#000000', mixAmount: 0 },
    clouds: { mul: 0.82, mix: '#c8d0da', mixAmount: 0.1 },
    rain:   { mul: 0.6,  mix: '#7c8795', mixAmount: 0.22 },
    storm:  { mul: 0.38, mix: '#4a525e', mixAmount: 0.35 },
  };
  const platformColor = $derived.by(() => {
    const t = PLATFORM_TINT[weather];
    const base = new Color(COLORS.ground).multiplyScalar(t.mul);
    return base.lerp(new Color(t.mix), t.mixAmount).getStyle();
  });

  // City extent — bounding box of every populated district pad, in world
  // units. Used to size the ground plane and frame the camera so the
  // populated area always fills the canvas, regardless of how sparsely
  // districts are spread inside the (fixed-size) generation grid.
  const cityBounds = $derived.by(() => {
    const populated = new Set<string>();
    for (const o of world.objects) populated.add(o.districtId);
    for (const a of world.agents) populated.add(a.districtId);
    // Outskirts only counts if populated (keeps empty repos compact).
    // Graveyard always counts so the memorial district is visible even in
    // repos with zero reverts yet — the pad itself reads as a place.
    const relevant = world.districts.filter(
      (d) => (!d.isOutskirts && !d.isGraveyard) || populated.has(d.id) || d.isGraveyard,
    );
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const d of relevant) {
      // Match the pad placement: compute the bbox rectangle instead of
      // treating the center tile's center as the pad midpoint. For even
      // districtSize the two differ by half a tile.
      const hw = Math.floor(d.sizeInTiles.w / 2);
      const hh = Math.floor(d.sizeInTiles.h / 2);
      const bboxCx = d.center.x - hw + (d.sizeInTiles.w - 1) / 2;
      const bboxCy = d.center.y - hh + (d.sizeInTiles.h - 1) / 2;
      const c = tileToWorld({ x: bboxCx, y: bboxCy }, world.grid, 0);
      const halfW = (d.sizeInTiles.w / 2) * TILE_SIZE;
      const halfD = (d.sizeInTiles.h / 2) * TILE_SIZE;
      if (c.x - halfW < minX) minX = c.x - halfW;
      if (c.x + halfW > maxX) maxX = c.x + halfW;
      if (c.z - halfD < minZ) minZ = c.z - halfD;
      if (c.z + halfD > maxZ) maxZ = c.z + halfD;
    }
    if (!Number.isFinite(minX)) {
      minX = -world.grid.w / 2;
      maxX = world.grid.w / 2;
      minZ = -world.grid.h / 2;
      maxZ = world.grid.h / 2;
    }
    const pad = TILE_SIZE * 2;
    const width = maxX - minX + pad * 2;
    const depth = maxZ - minZ + pad * 2;
    return {
      width,
      depth,
      cx: (minX + maxX) / 2,
      cz: (minZ + maxZ) / 2,
      maxDim: Math.max(width, depth),
    };
  });

  const maxDim = $derived(cityBounds.maxDim);
  const camDist = $derived(maxDim * 1.2);

  // Initial camera framing — kept as reactive derivations so the rail's
  // Reset button can restore the computed default regardless of the
  // user's current orbit / pan state. Both props feed directly into the
  // PerspectiveCamera + OrbitControls below.
  const initialCamPos = $derived<[number, number, number]>([
    cityBounds.cx + camDist * 0.7,
    camDist * 0.9,
    cityBounds.cz + camDist * 0.7,
  ]);
  const initialTarget = $derived<[number, number, number]>([
    cityBounds.cx,
    0,
    cityBounds.cz,
  ]);

  let orbitRef = $state<ThreeOrbitControls | undefined>();

  // Expose the camera API once OrbitControls mounts. The ref is bindable
  // from Threlte's wrapper; we notify the parent so the floating tool
  // rail can drive zoom / reset / mouse mode.
  $effect(() => {
    if (!orbitRef || !onReady) return;
    const controls = orbitRef;
    const dollyBy = (factor: number) => {
      const cam = controls.object;
      const offset = cam.position.clone().sub(controls.target);
      const clamped = Math.max(
        controls.minDistance,
        Math.min(controls.maxDistance, offset.length() * factor),
      );
      offset.setLength(clamped);
      cam.position.copy(controls.target).add(offset);
      controls.update();
    };
    onReady({
      zoomIn: () => dollyBy(1 / 1.2),
      zoomOut: () => dollyBy(1.2),
      reset: () => {
        controls.object.position.set(...initialCamPos);
        controls.target.set(...initialTarget);
        controls.update();
      },
      setMode: (mode) => {
        controls.mouseButtons =
          mode === 'pan'
            ? { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }
            : { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
      },
    });
  });

  // Grow the city platform past cityBounds so its edge hides under the
  // first ring of hex grass — otherwise a ~half-hex strip of sea shows
  // through at the seam. 2 world units ≈ one full hex, safely covers
  // the gap at any HEX_FLAT ≤ 2.
  const PLATFORM_BLEED = 2;

  // Pre-compute district bounds once per world change. Invariant #2:
  // districts are immutable on sync, so this stays stable between
  // ingestion events.
  //
  // The pad is positioned against the district's bbox rectangle rather than
  // the center tile. For odd districtSize these two coincide; for even
  // districtSize the tile-center is offset half a tile from the bbox center
  // (because `districtBBox` anchors with `floor(W/2)`), so using the tile
  // center here would bleed the pad half a tile onto the adjacent road.
  // Apply the same weather darkening to arbitrary pad colors so every
  // "paved" surface (platform + district pads) tints together. Without
  // this the pads (previously Standard-lit) and the platform (Basic +
  // manual tint) would drift apart under rain/storm.
  function tintForWeather(hex: string): string {
    const t = PLATFORM_TINT[weather];
    const c = new Color(hex).multiplyScalar(t.mul);
    return c.lerp(new Color(t.mix), t.mixAmount).getStyle();
  }

  const districtPads = $derived(
    world.districts.map((d) => {
      const hw = Math.floor(d.sizeInTiles.w / 2);
      const hh = Math.floor(d.sizeInTiles.h / 2);
      const bboxCx = d.center.x - hw + (d.sizeInTiles.w - 1) / 2;
      const bboxCy = d.center.y - hh + (d.sizeInTiles.h - 1) / 2;
      const center = tileToWorld({ x: bboxCx, y: bboxCy }, world.grid, 0.02);
      const base = d.isGraveyard
        ? COLORS.graveyardGround
        : d.isOutskirts
          ? COLORS.outskirtsGround
          : COLORS.districtGround;
      return {
        id: d.id,
        center,
        width: d.sizeInTiles.w * TILE_SIZE,
        depth: d.sizeInTiles.h * TILE_SIZE,
        color: tintForWeather(base),
      };
    }),
  );
</script>

<!-- Camera + controls. `far` is bumped past the Sky box scale (10000)
     so the atmospheric skybox isn't clipped; near stays small because
     props like agents can come within arm's reach of the camera. -->
<T.PerspectiveCamera
  makeDefault
  position={initialCamPos}
  fov={35}
  near={0.5}
  far={30000}
>
  <OrbitControls
    bind:ref={orbitRef}
    target={initialTarget}
    enableDamping
    maxPolarAngle={Math.PI / 2.1}
    minDistance={maxDim * 0.4}
    maxDistance={maxDim * 2.5}
  />
</T.PerspectiveCamera>

<!-- Lights: warm key from above-front, soft ambient fill. Both respond
     to the weather preset so overcast/rain/storm darken + desaturate
     the scene without editing per-object materials. -->
<T.AmbientLight intensity={light.amb} color={light.ambColor} />
<T.DirectionalLight
  position={[maxDim * 0.6, maxDim * 1.1, maxDim * 0.4]}
  intensity={light.dir}
  color={light.dirColor}
  castShadow
/>

<!-- Sea: a single huge dark-blue plane far below the island, handles the
     horizon past the outermost water hex so the world doesn't end at a
     visible edge. Sits at Y < the water hex tops so its surface reads as
     deeper open water around the island. -->
<T.Mesh
  position={[cityBounds.cx, -0.55, cityBounds.cz]}
  rotation={[-Math.PI / 2, 0, 0]}
  receiveShadow
>
  <T.PlaneGeometry args={[cityBounds.maxDim * 12, cityBounds.maxDim * 12]} />
  <T.MeshStandardMaterial color="#2b4a6b" roughness={0.85} />
</T.Mesh>

<!-- City platform: flat grass under the populated districts. District
     pads paint over this — the platform exists so hex tiles don't need
     to fill the city interior (which would clip with district pads).
     Rendered slightly larger than cityBounds (PLATFORM_BLEED) so the
     edge reliably tucks under the first ring of grass hexes; without
     this, a ~half-hex strip of sea shows through at the seam where
     hex centers can't sit closer than half a tile to the cityBounds
     rect. The bleed is pure grass color so extending past the
     populated area is visually invisible. -->
<T.Mesh
  position={[cityBounds.cx, 0, cityBounds.cz]}
  rotation={[-Math.PI / 2, 0, 0]}
>
  <T.PlaneGeometry args={[cityBounds.width + PLATFORM_BLEED, cityBounds.depth + PLATFORM_BLEED]} />
  <!-- MeshBasicMaterial + toneMapped=false: the platform must land
       exactly on the Kenney palette colour (#4f896a) so it blends with
       the unlit-looking hex grass. MeshStandardMaterial under our
       ambient+directional rig darkens it to ~#476544, and the
       renderer's default ACES tone-mapping shifts it further. Basic
       bypasses lighting; `toneMapped=false` bypasses the tone curve.
       The color is now derived from the weather preset so the platform
       visually tracks how the hex tiles darken under overcast/storm.
       We lose shadow-reception on the platform, which is fine — it's
       covered by districts/roads/buildings above. -->
  <T.MeshBasicMaterial color={platformColor} toneMapped={false} />
</T.Mesh>

<!-- Hex-island surround: grass/sand/water rings around the city. -->
<Island {world} bounds={cityBounds} />

<!-- District pads. Basic + toneMapped=false matches the platform's
     unlit model so platform and pads darken in lockstep under weather.
     Previously these used MeshStandardMaterial; under non-sun weather
     the pads would darken via the dimmer light rig while the Basic
     platform stayed bright, producing a visible step between them. -->
{#each districtPads as pad (pad.id)}
  <T.Mesh
    position={[pad.center.x, pad.center.y, pad.center.z]}
    rotation={[-Math.PI / 2, 0, 0]}
  >
    <T.PlaneGeometry args={[pad.width, pad.depth]} />
    <T.MeshBasicMaterial color={pad.color} toneMapped={false} />
  </T.Mesh>
{/each}

<Roads {world} />
<Buildings {world} {onPick} />
<Scenery {world} {onPick} />
<Agents {world} {sim} {onPick} />

<!-- Procedural sky: Preetham atmospheric-scattering shader, same look as
     the three.js webgl_shaders_sky example. Mounts behind everything —
     Sky's BoxGeometry is rendered with depth baked into the shader so
     other geometry always draws on top. Weather's clouds/fog layer
     still composites over it for overcast/rain/storm. -->
<Sky
  turbidity={sky.turbidity}
  rayleigh={sky.rayleigh}
  mieCoefficient={sky.mieCoefficient}
  mieDirectionalG={sky.mieDirectionalG}
  elevation={sky.elevation}
  azimuth={sky.azimuth}
/>

<!-- Atmospheric layer: clouds, rain, fog, lightning. Sits above the
     scene graph so fog applies uniformly regardless of mount order. -->
<Weather mode={weather} bounds={cityBounds} seed={weatherSeed} />
