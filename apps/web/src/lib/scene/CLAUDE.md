# Scene module — what lives here

3D rendering layer for the GitColony web app. Built on Threlte 8 + three.js
(GLTF assets from Kenney CC0 packs). Pure rendering — never imports from
`@gitcolony/db`, `@gitcolony/github`, or any I/O surface.

## Component map

- `ColonyScene.svelte` — orchestrator. Owns camera, lights, sea plane,
  city platform, district pads, and mounts the four asset layers below.
- `Buildings.svelte` — tier-B commits as Kenney City Kit GLBs.
- `Roads.svelte` — Kenney City Kit Roads, oriented by 4-neighbor mask.
- `Scenery.svelte` — tier-C/D decor + road-side scenery.
- `Agents.svelte` — Mini Characters with `AnimationMixer` (walk loop).
- `Island.svelte` — hex-tile terrain ring around the city (Hexagon Kit).

## Ground rendering — old vs new

The current scene is built around the **island concept**:

```
  sea plane (Y = -0.55, dark blue, spans maxDim × 12)
  └── water hex tops (Y ≈ -0.22 — one "cliff-step" below land)
      └── sand / grass / forest / hill hex tops (Y = 0)  ──┐
      └── city platform plane (Y = 0, cityBounds rect)  ───┤ flush surface
          └── district pads (Y = 0.02, colored squares)  ──┘
              └── roads (Y = 0.01), buildings, agents
```

`Island.svelte` derives its Y levels from `HEX_FLAT` so if you retune
the tile scale the layering still holds:

- `LAND_BASE_Y = -0.2 × HEX_FLAT` — puts a flat tile's top at Y = 0.
- `COAST_DROP = 0.22` — how far water top sits below land top.
- `WATER_BASE_Y = -COAST_DROP - 0.1 × HEX_FLAT` — water slab base.

`Island.svelte` generates a deterministic honeycomb around `cityBounds`
keyed by `world.seed`, so each repo grows the same island shape across
sessions. Variants (grass-forest, grass-hill, stone-mountain, water-rocks
etc.) are picked from per-tier pools by per-tile noise.

### Old ground (removed — kept here only as historical reference)

Before Island, `ColonyScene.svelte` painted two flat planes:

- An outer `groundDark` plane at Y = -0.02, sized `maxDim × 3` × `maxDim × 3`.
- An inner `ground` plane at Y = 0, sized to `cityBounds.width × depth`.

Both were `MeshStandardMaterial` with solid colors from `COLORS` in
`mapping.ts`. The dark outer plane was supposed to read as "wider
landscape" but at typical zoom it read as a giant green void with a
square city floating in the middle — that's what motivated the swap.

`COLORS.ground` (and the city platform plane that uses it) is still
alive: it sits under the district pads inside `cityBounds`. We don't
fill the city interior with hex tiles because they would clip with the
district pads. `COLORS.groundDark` is dead now and could be removed
from `mapping.ts` once we're sure we don't roll back.

## Asset pipeline

Source GLBs live in `/textures/<Pack>/Models/GLB format/`. They are
copied into `apps/web/static/models/<category>/` by
`scripts/copy-assets.sh`, which also installs each pack's `Textures/`
sibling folder so external `colormap.png` references resolve. Categories
currently used:

- `buildings/{suburban,commercial,industrial,low-detail}` — City Kits.
- `roads/` — City Kit Roads (road tiles + light posts).
- `nature/` — Nature Kit (trees, bushes, rocks; embedded textures).
- `characters/` — Mini Characters (12 male/female variants, rigged with
  walk/idle/etc clips).
- `terrain/` — Hexagon Kit (grass / sand / water / mountain hex slabs).
- `pets/`, `cars/`, `props/{car,graveyard,fantasy}/` — misc.

The mapping from abstract variant strings (`workshop-01`, `tree-02`, …)
to concrete GLB paths lives in `assets.ts`. Picking is deterministic via
FNV-1a of `(commitSha, variant)` or `agent.id`, so the same colony
always looks the same.

## GLTF loading (`gltf.ts`)

- One `GLTFLoader` instance, URL-keyed cache of `{ scene, animations }`.
- `cloneTemplate(url)` — `SkeletonUtils.clone` so rigged meshes work.
- `cloneWithAnimations(url)` — clone + the template's clips (clips are
  shared, mixers bind them to their own root).
- `templateExtent(url)` — cached XYZ bbox so consumers fit-to-footprint
  without measuring per instance.
- `preload(urls)` — fire-and-forget.

## Sim wiring (`sim.svelte.ts`)

Client-only. Wraps `@gitcolony/core/sim` and exposes `poses` (a $state
array) for `Agents.svelte`. Tick cadence in `TICK_SECONDS`; agents
walk one tile per tick with linear interpolation between.

Imports from `@gitcolony/core/sim` (subpath, NOT the root barrel) to
avoid pulling `node:crypto` into the client bundle — the root re-exports
`seed.ts` which loads it.

## Rules of thumb

- No business logic here. If it touches the DB, GitHub, or auth, it
  belongs in `apps/api` or a `packages/*`.
- Stay under 300 lines per component. Split by responsibility.
- New asset pack = update `copy-assets.sh` AND `assets.ts` in the same
  change. Copy the pack's `Textures/` next to the destination folder.
- Variants in `assets.ts` keys are **contract surface** with
  `@gitcolony/core` (invariants #2/#4) — don't rename them; add new
  ones at most.
