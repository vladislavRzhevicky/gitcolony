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
<script lang="ts">
  import { T, useTask } from '@threlte/core';
  import { OrbitControls } from '@threlte/extras';
  import Buildings from './Buildings.svelte';
  import Roads from './Roads.svelte';
  import Scenery from './Scenery.svelte';
  import Agents from './Agents.svelte';
  import Island from './Island.svelte';
  import {
    COLORS,
    TILE_SIZE,
    tileToWorld,
    type Picked,
    type World,
  } from './mapping';
  import { AgentSim } from './sim.svelte';

  interface Props {
    world: World;
    onPick?: (picked: Picked) => void;
  }

  let { world, onPick }: Props = $props();

  // Client-side simulation. Rebuilt whenever the world identity changes —
  // sync/regenerate flows invalidate the page and hand us a fresh world,
  // so this effectively resets the sim on ingestion events.
  const sim = $derived(new AgentSim(world));
  useTask((delta) => sim.tick(delta));

  // City extent — bounding box of every populated district pad, in world
  // units. Used to size the ground plane and frame the camera so the
  // populated area always fills the canvas, regardless of how sparsely
  // districts are spread inside the (fixed-size) generation grid.
  const cityBounds = $derived.by(() => {
    const populated = new Set<string>();
    for (const o of world.objects) populated.add(o.districtId);
    for (const a of world.agents) populated.add(a.districtId);
    const relevant = world.districts.filter(
      (d) => !d.isOutskirts || populated.has(d.id),
    );
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const d of relevant) {
      const c = tileToWorld(d.center, world.grid, 0);
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

  // Grow the city platform past cityBounds so its edge hides under the
  // first ring of hex grass — otherwise a ~half-hex strip of sea shows
  // through at the seam. 2 world units ≈ one full hex, safely covers
  // the gap at any HEX_FLAT ≤ 2.
  const PLATFORM_BLEED = 2;

  // Pre-compute district bounds once per world change. Invariant #2:
  // districts are immutable on sync, so this stays stable between
  // ingestion events.
  const districtPads = $derived(
    world.districts.map((d) => {
      const center = tileToWorld(d.center, world.grid, 0.02);
      return {
        id: d.id,
        center,
        width: d.sizeInTiles.w * TILE_SIZE,
        depth: d.sizeInTiles.h * TILE_SIZE,
        color: d.isOutskirts ? COLORS.outskirtsGround : COLORS.districtGround,
      };
    }),
  );
</script>

<!-- Camera + controls -->
<T.PerspectiveCamera
  makeDefault
  position={[cityBounds.cx + camDist * 0.7, camDist * 0.9, cityBounds.cz + camDist * 0.7]}
  fov={35}
>
  <OrbitControls
    target={[cityBounds.cx, 0, cityBounds.cz]}
    enableDamping
    maxPolarAngle={Math.PI / 2.1}
    minDistance={maxDim * 0.4}
    maxDistance={maxDim * 2.5}
  />
</T.PerspectiveCamera>

<!-- Lights: warm key from above-front, soft ambient fill -->
<T.AmbientLight intensity={0.55} color="#f4e9d0" />
<T.DirectionalLight
  position={[maxDim * 0.6, maxDim * 1.1, maxDim * 0.4]}
  intensity={1.3}
  color="#ffe8c2"
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
       We lose shadow-reception on the platform, which is fine — it's
       covered by districts/roads/buildings above. -->
  <T.MeshBasicMaterial color={COLORS.ground} toneMapped={false} />
</T.Mesh>

<!-- Hex-island surround: grass/sand/water rings around the city. -->
<Island {world} bounds={cityBounds} />

<!-- District pads -->
{#each districtPads as pad (pad.id)}
  <T.Mesh
    position={[pad.center.x, pad.center.y, pad.center.z]}
    rotation={[-Math.PI / 2, 0, 0]}
    receiveShadow
  >
    <T.PlaneGeometry args={[pad.width, pad.depth]} />
    <T.MeshStandardMaterial color={pad.color} roughness={1} />
  </T.Mesh>
{/each}

<Roads {world} />
<Buildings {world} {onPick} />
<Scenery {world} {onPick} />
<Agents {world} {sim} {onPick} />
