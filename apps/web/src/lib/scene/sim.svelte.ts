import type { World } from '@gitcolony/schema';
// Subpath import (not '@gitcolony/core') so the client bundle stays free of
// `node:crypto` — the root barrel re-exports `seed.ts` which imports it at
// module top. The `./sim` entry exposes only browser-safe code paths.
import {
  type AgentRuntime,
  buildRoadMask,
  buildSimWalkable,
  collectPOIs,
  flattenPOIs,
  initAgentRuntimes,
  stepAgent,
} from '@gitcolony/core/sim';
import { TILE_SIZE, tileToWorld } from './mapping';

// ============================================================================
// Client-side agent simulation.
//
// Runs entirely on the client — the server never ticks. Agents step one
// tile at a time at `TICK_SECONDS` cadence; between ticks we interpolate
// linearly from the previous tile to the next so motion reads as smooth
// walking rather than teleporting.
//
// The renderer doesn't own pathfinding; it only reads `poses`. The class
// hides the @gitcolony/core step machinery and re-exposes a flat array of
// render-ready positions that Svelte can reactively track via $state.
// ============================================================================

const TICK_SECONDS = 0.9; // one tile per ~900ms — reads as a leisurely stroll

export interface AgentPose {
  id: string;
  x: number; // world X (scene-space)
  z: number; // world Z
  yaw: number; // radians; facing the current step direction
}

interface Slot {
  rt: AgentRuntime;
  // Interpolation anchors. `from` = tile occupied at the start of this
  // step, `to` = tile we're moving toward. Both in world coordinates.
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  yaw: number;
}

export class AgentSim {
  // $state array rendered by Svelte — stable references per agent so the
  // `{#each ... (id)}` block doesn't tear down meshes every frame.
  poses = $state<AgentPose[]>([]);

  private slots: Slot[] = [];
  private elapsed = 0;
  private world: World;
  // Captured once at construction — districts/objects don't mutate at
  // runtime, so we don't need to rebuild between ticks. Sync / extend
  // paths run in the worker and the page invalidates the whole world on
  // that event, remounting this class.
  private walkable;
  private roadMask;
  private pois;

  constructor(world: World) {
    this.world = world;
    this.walkable = buildSimWalkable(world);
    this.roadMask = buildRoadMask(world);
    // Sim uses a flat, world-wide POI list so agents visit every district in
    // rotation rather than orbiting their home pad. `flattenPOIs` dedupes
    // and sorts deterministically so the rotation is reproducible.
    this.pois = flattenPOIs(collectPOIs(world, this.walkable));
    const runtimes = initAgentRuntimes(
      world,
      this.walkable,
      collectPOIs(world, this.walkable),
      this.roadMask,
    );
    this.slots = runtimes.map((rt: AgentRuntime) => this.slotFromRuntime(rt));
    this.poses = this.slots.map((s) => ({
      id: s.rt.id,
      x: s.fromX,
      z: s.fromZ,
      yaw: s.yaw,
    }));
  }

  /**
   * Advances the sim by `dt` seconds. Called from Threlte's useTask each
   * frame. When the accumulated delta exceeds TICK_SECONDS we call into
   * the pure core stepper and rebuild each slot's interpolation anchors.
   *
   * We don't fast-forward across multiple ticks in one frame — a dropped
   * frame just reads as a slightly faster single step. Keeping it simple
   * avoids big jumps when the tab regains focus after being backgrounded.
   */
  tick(dt: number): void {
    this.elapsed += dt;
    if (this.elapsed >= TICK_SECONDS) {
      this.elapsed = Math.min(this.elapsed - TICK_SECONDS, TICK_SECONDS);
      for (const s of this.slots) {
        stepAgent(s.rt, this.walkable, this.pois, this.roadMask);
        this.rearmSlot(s);
      }
    }
    const a = this.elapsed / TICK_SECONDS;
    // Rebuild poses as a new array so $state tracking notices the change.
    // Per-agent object identity is preserved via the id key in the Svelte
    // #each block; we only allocate small flat objects here.
    this.poses = this.slots.map((s) => ({
      id: s.rt.id,
      x: s.fromX + (s.toX - s.fromX) * a,
      z: s.fromZ + (s.toZ - s.fromZ) * a,
      yaw: s.yaw,
    }));
  }

  private slotFromRuntime(rt: AgentRuntime): Slot {
    const from = tileToWorld(rt.pos, this.world.grid, 0);
    const nextTile = rt.path[0] ?? rt.pos;
    const to = tileToWorld(nextTile, this.world.grid, 0);
    return {
      rt,
      fromX: from.x,
      fromZ: from.z,
      toX: to.x,
      toZ: to.z,
      yaw: computeYaw(from.x, from.z, to.x, to.z, 0),
    };
  }

  private rearmSlot(s: Slot): void {
    const from = tileToWorld(s.rt.pos, this.world.grid, 0);
    // After stepAgent, pos is the tile we just arrived at. The next tile
    // is path[0] (or pos itself if we're stuck / just replanned and have
    // no path).
    const nextTile = s.rt.path[0] ?? s.rt.pos;
    const to = tileToWorld(nextTile, this.world.grid, 0);
    s.fromX = from.x;
    s.fromZ = from.z;
    s.toX = to.x;
    s.toZ = to.z;
    s.yaw = computeYaw(from.x, from.z, to.x, to.z, s.yaw);
  }
}

// Face the direction of motion. When the agent is idle (from ≈ to), keep
// the previous yaw — otherwise the mesh snaps to 0 on every stuck tick.
function computeYaw(fx: number, fz: number, tx: number, tz: number, prev: number): number {
  const dx = tx - fx;
  const dz = tz - fz;
  if (Math.abs(dx) + Math.abs(dz) < 1e-4 * TILE_SIZE) return prev;
  return Math.atan2(dx, dz);
}
