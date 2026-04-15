<!--
  Buildings — renders tier-B WorldObjects as GLB instances from the Kenney
  City Kit packs.

  Scaling: Kenney packs ship at varying intrinsic world scales. We read the
  template bbox once per URL (cached in gltf.ts) and derive a uniform scale
  so the model spans ~92% of its footprint. Height isn't stretched — the
  ranker already encodes commit weight into pool selection indirectly.

  Rendering: per-building local state resolves asynchronously, so the list
  grows as GLBs land. Each entry sits under a <T.Group> that forwards
  clicks back to the parent via onPick.
-->
<script lang="ts">
  import { T } from '@threlte/core';
  import type { Object3D } from 'three';
  import type { World, WorldObject } from '@gitcolony/schema';
  import { buildingModel } from './assets';
  import { cloneTemplate, templateExtent } from './gltf';
  import { footprintBounds, pickedFromObject, type Picked } from './mapping';

  interface Props {
    world: World;
    onPick?: (p: Picked) => void;
  }
  let { world, onPick }: Props = $props();

  interface BuildingInstance {
    obj: WorldObject;
    scene: Object3D;
    cx: number;
    cz: number;
    scale: number;
  }

  let instances = $state<BuildingInstance[]>([]);

  // Resolve every building asynchronously. Rebuilds whenever the world
  // identity changes — sync flows hand us a fresh world object, so this
  // effectively re-instantiates the scene on ingestion.
  $effect(() => {
    let cancelled = false;
    instances = [];
    const tierB = world.objects.filter((o) => o.tier === 'B');

    Promise.all(
      tierB.map(async (obj) => {
        const url = buildingModel(obj);
        const [scene, extent] = await Promise.all([cloneTemplate(url), templateExtent(url)]);
        const b = footprintBounds(obj, world.grid);
        const fitW = b.width * 0.92;
        const fitD = b.depth * 0.92;
        // Smaller of the two ratios keeps the building inside its footprint
        // even when the model is elongated in one axis.
        const scale =
          extent.x > 0 && extent.z > 0 ? Math.min(fitW / extent.x, fitD / extent.z) : 1;
        return { obj, scene, cx: b.center.x, cz: b.center.z, scale } satisfies BuildingInstance;
      }),
    ).then((resolved) => {
      if (!cancelled) instances = resolved;
    });

    return () => {
      cancelled = true;
    };
  });

  function handleClick(e: unknown, obj: WorldObject) {
    (e as { stopPropagation?: () => void }).stopPropagation?.();
    onPick?.(pickedFromObject(obj));
  }
</script>

{#each instances as inst (inst.obj.id)}
  <T.Group
    position={[inst.cx, 0, inst.cz]}
    scale={[inst.scale, inst.scale, inst.scale]}
    onclick={(e: unknown) => handleClick(e, inst.obj)}
  >
    <T is={inst.scene} />
  </T.Group>
{/each}
