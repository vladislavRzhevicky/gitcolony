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
  import { Color, Mesh, type Material, type Object3D } from 'three';
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
        // 1.38 = 0.92 × 1.5 — buildings were sized to 92% of their
        // footprint; bumping by 1.5× lets them read as proper structures
        // next to the scaled-down characters. This is purely a render
        // knob: the walkability grid (roads, footprints, A* in core)
        // doesn't care what the mesh actually fills, so agents still
        // path around the original footprint tiles. Visible side effect:
        // buildings now spill over their pad edges into adjacent road
        // margins, which reads as "houses touching the curb".
        const fitW = b.width * 1.38;
        const fitD = b.depth * 1.38;
        // Smaller of the two ratios keeps the building inside its footprint
        // even when the model is elongated in one axis.
        const scale =
          extent.x > 0 && extent.z > 0 ? Math.min(fitW / extent.x, fitD / extent.z) : 1;
        tintBuilding(scene, obj.commitSha);
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

  // Per-building deterministic tint. Kenney City Kit GLBs share one
  // material that samples a single colormap atlas, so we can't recolor
  // just the roof — instead we multiply the whole atlas by a seeded
  // pastel tint, which reads as "each house has its own palette"
  // without breaking the Kenney look. `material.color` multiplies the
  // baseColorTexture, so we stay close to white for low shift and pick
  // a specific hue via HSL. Saturation is kept low (0.35) and lightness
  // high (0.78) so the tint reads as a coloured variant, not a stain.
  //
  // Materials are shared across clones inside three.js, so tinting a
  // non-cloned material would recolour every instance at once. We clone
  // the material per building (once per mesh traversal) to keep tints
  // independent.
  function tintBuilding(scene: Object3D, commitSha: string) {
    // Remap hue into [0.05, 0.83] — skips the magenta/pink/deep-red arc
    // (≈300°–360° + 0°–18°) so buildings don't pick up bubblegum tints.
    const h = 0.05 + (fnv1a(commitSha) / 0xffffffff) * 0.78;
    // S=0.55/L=0.62 — saturated enough that hue variation is obvious
    // while staying off the primary rails so the scene doesn't read as
    // toys. Multiplies the Kenney atlas, so roofs and walls both shift
    // toward the same hue but the atlas's internal value contrast
    // (dark roof vs lighter wall) is preserved.
    const tint = new Color().setHSL(h, 0.55, 0.62);
    scene.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const mat = node.material;
      // Kenney GLBs out of UnityGLTF ship as MeshStandardMaterial, but
      // we branch on capability (has a `.color`) rather than the class
      // so re-exports with different material classes keep tinting.
      const tintOne = (m: Material): Material => {
        const colored = m as Material & { color?: Color };
        if (!colored.color) return m;
        const clone = m.clone() as Material & { color: Color };
        clone.color.copy(tint);
        return clone;
      };
      node.material = Array.isArray(mat) ? mat.map(tintOne) : tintOne(mat);
    });
  }

  function fnv1a(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
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
