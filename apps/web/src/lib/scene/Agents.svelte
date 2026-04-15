<!--
  Agents — renders tier-A WorldAgents using Mini Characters GLBs, driven
  by the client-side AgentSim for per-frame interpolated movement and by
  an AnimationMixer for limb animation.

  The GLB clone for each agent is loaded once at mount (keyed by agent.id)
  and reused across ticks — we only move its Group. Loading is async, so
  agents visibly pop in as their models resolve.

  Mini Characters ship with ~32 clips (walk / idle / sprint / …). We bind
  "walk" by default so the limbs cycle while the sim translates the Group
  across tiles. If a clip named "walk" isn't present we fall back to the
  first clip on the model, so the pack stays swappable without code edits.
-->
<script lang="ts">
  import { T, useTask } from '@threlte/core';
  import { AnimationMixer, type AnimationAction, type AnimationClip, type Object3D } from 'three';
  import type { World, Agent } from '@gitcolony/schema';
  import { agentModel } from './assets';
  import { cloneWithAnimations, templateExtent } from './gltf';
  import { pickedFromAgent, type Picked } from './mapping';
  import type { AgentSim } from './sim.svelte';

  interface Props {
    world: World;
    sim: AgentSim;
    onPick?: (p: Picked) => void;
  }
  let { world, sim, onPick }: Props = $props();

  interface Instance {
    scene: Object3D;
    scale: number;
    mixer: AnimationMixer | null;
    action: AnimationAction | null;
  }

  // id -> prepared instance (scene + scale + mixer). Built once per world
  // change. The sim's per-frame poses then drive position/yaw reactively
  // via direct lookup in the #each block below.
  let instanceMap = $state<Map<string, Instance>>(new Map());

  const agentsById = $derived(new Map(world.agents.map((a) => [a.id, a])));

  $effect(() => {
    let cancelled = false;
    instanceMap = new Map();

    Promise.all(
      world.agents.map(async (a) => {
        const url = agentModel(a);
        const [{ scene, animations }, extent] = await Promise.all([
          cloneWithAnimations(url),
          templateExtent(url),
        ]);
        // Mini Characters ship roughly human-sized in their native units;
        // we target ~0.9 world units tall to sit nicely on TILE_SIZE=1.
        const scale = extent.y > 0 ? 0.9 / extent.y : 1;

        let mixer: AnimationMixer | null = null;
        let action: AnimationAction | null = null;
        if (animations.length > 0) {
          mixer = new AnimationMixer(scene);
          const clip = pickClip(animations, 'walk') ?? animations[0]!;
          action = mixer.clipAction(clip);
          // Match the walk cycle to the sim's tile cadence — the default
          // clip runs too fast for our 900ms-per-tile stroll and reads as
          // running-in-place. Halving timeScale brings feet and ground
          // speed back in sync.
          action.timeScale = 0.5;
          // Give each agent a random phase offset so a cluster of three
          // characters doesn't step in perfect lockstep — still
          // deterministic in-session, we just seed from agent.id.
          action.time = phaseOffset(a.id) * clip.duration;
          action.play();
        }

        return [a.id, { scene, scale, mixer, action }] as const;
      }),
    ).then((entries) => {
      if (!cancelled) instanceMap = new Map(entries);
    });

    return () => {
      cancelled = true;
    };
  });

  // Advance every mixer by the frame delta. Runs regardless of whether any
  // agent actually moved this frame — the walk cycle should continue
  // visually even during the interpolation inside a single sim tick.
  useTask((dt) => {
    for (const inst of instanceMap.values()) {
      inst.mixer?.update(dt);
    }
  });

  function pickClip(clips: readonly AnimationClip[], name: string): AnimationClip | undefined {
    return clips.find((c) => c.name === name);
  }

  // Deterministic phase offset in [0, 1) derived from the agent id.
  function phaseOffset(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
    return ((h >>> 0) % 1000) / 1000;
  }

  function handleClick(e: unknown, a: Agent | undefined) {
    if (!a) return;
    (e as { stopPropagation?: () => void }).stopPropagation?.();
    onPick?.(pickedFromAgent(a));
  }
</script>

{#each sim.poses as pose (pose.id)}
  {@const inst = instanceMap.get(pose.id)}
  {#if inst}
    <T.Group
      position={[pose.x, 0, pose.z]}
      rotation={[0, pose.yaw, 0]}
      scale={[inst.scale, inst.scale, inst.scale]}
      onclick={(e: unknown) => handleClick(e, agentsById.get(pose.id))}
    >
      <T is={inst.scene} />
    </T.Group>
  {/if}
{/each}
