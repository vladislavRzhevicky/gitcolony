<!--
  Scenery — non-tier-B objects (tier-C and tier-D decor) plus the road-side
  SceneryProps. Everything here routes through the decor/scenery registry
  in assets.ts and the GLB cache in gltf.ts.

  Tier-C/D objects are click-pickable (they're commit-backed). SceneryProps
  are purely decorative and skip click routing, matching the behavior of
  the previous primitive-based scene.
-->
<script lang="ts">
  import { T } from '@threlte/core';
  import type { Object3D } from 'three';
  import type { World, WorldObject, SceneryProp } from '@gitcolony/schema';
  import { decorModel, sceneryModel } from './assets';
  import { cloneTemplate } from './gltf';
  import { pickedFromObject, tileToWorld, type Picked } from './mapping';

  interface Props {
    world: World;
    onPick?: (p: Picked) => void;
  }
  let { world, onPick }: Props = $props();

  interface DecorInstance {
    id: string;
    scene: Object3D;
    x: number;
    y: number;
    z: number;
    scale: number;
    rotationY: number;
    obj: WorldObject | null; // null for scenery props (non-pickable)
  }

  let instances = $state<DecorInstance[]>([]);

  $effect(() => {
    let cancelled = false;
    instances = [];

    type Job = { id: string; url: string; x: number; z: number; y: number; scale: number; rotationY: number; obj: WorldObject | null };
    const jobs: Job[] = [];

    for (const obj of world.objects) {
      if (obj.tier === 'B') continue; // handled by Buildings.svelte
      const model = decorModel(obj);
      if (!model) continue;
      const p = tileToWorld(obj.anchor, world.grid, 0);
      jobs.push({
        id: obj.id,
        url: model.path,
        x: p.x,
        z: p.z,
        y: model.yOffset,
        scale: model.scale,
        rotationY: 0,
        obj,
      });
    }

    for (const prop of world.scenery as SceneryProp[]) {
      const model = sceneryModel(prop);
      const p = tileToWorld(prop.anchor, world.grid, 0);
      jobs.push({
        id: prop.id,
        url: model.path,
        x: p.x,
        z: p.z,
        y: model.yOffset,
        scale: model.scale,
        rotationY: prop.rotationY ?? 0,
        obj: null,
      });
    }

    Promise.all(
      jobs.map(async (j): Promise<DecorInstance> => {
        const scene = await cloneTemplate(j.url);
        return { id: j.id, scene, x: j.x, y: j.y, z: j.z, scale: j.scale, rotationY: j.rotationY, obj: j.obj };
      }),
    ).then((resolved) => {
      if (!cancelled) instances = resolved;
    });

    return () => {
      cancelled = true;
    };
  });

  function handleClick(e: unknown, obj: WorldObject | null) {
    if (!obj) return;
    (e as { stopPropagation?: () => void }).stopPropagation?.();
    onPick?.(pickedFromObject(obj));
  }
</script>

{#each instances as inst (inst.id)}
  <T.Group
    position={[inst.x, inst.y, inst.z]}
    rotation={[0, inst.rotationY, 0]}
    scale={[inst.scale, inst.scale, inst.scale]}
    onclick={inst.obj ? (e: unknown) => handleClick(e, inst.obj) : undefined}
  >
    <T is={inst.scene} />
  </T.Group>
{/each}
