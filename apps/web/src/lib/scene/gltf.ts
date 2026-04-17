// ============================================================================
// GLTF/GLB loader with per-URL template caching.
//
// Templates are loaded once per URL; each consumer clones for its own
// placement. Consumers render via the <GltfInstance> child component which
// owns the $state for its clone — calling $state from inside an {#each}
// helper is not a supported pattern in Svelte 5, so instance reactivity
// lives on the component boundary.
// ============================================================================

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Box3, Vector3, type AnimationClip, type Object3D } from 'three';

const loader = new GLTFLoader();

// URL -> { scene, animations }. Scene is the original; callers must clone
// before adding to the live scene graph. AnimationClips are reusable as-is
// — AnimationMixer binds clips to a specific root at bind time.
interface LoadedTemplate {
  scene: Object3D;
  animations: AnimationClip[];
}
const templates = new Map<string, Promise<LoadedTemplate>>();

// URL -> cached bbox extent (x,y,z). Measured once per template so consumers
// can fit-to-footprint without re-running Box3.setFromObject per instance.
const extents = new Map<string, Vector3>();

// URL -> cached bbox center (x,y,z) in the template's native units. Some
// packs ship GLBs with geometry offset from origin (the city-free road pack
// does this — the intersection is centered near (-7, *, -19) instead of
// (0,0,0)). Consumers that position by tile centroid need to subtract this
// offset (scaled) from their placement to keep geometry over the tile.
const centers = new Map<string, Vector3>();

export function loadTemplate(url: string): Promise<LoadedTemplate> {
  const cached = templates.get(url);
  if (cached) return cached;
  const p = new Promise<LoadedTemplate>((resolve, reject) => {
    loader.load(
      url,
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations ?? [] }),
      undefined,
      (err) => reject(err),
    );
  });
  templates.set(url, p);
  return p;
}

/**
 * Returns a fresh clone of the loaded template. SkeletonUtils.clone covers
 * rigged meshes (Mini Characters have armatures) and degrades to a deep
 * Object3D.clone for static geometry, so callers don't branch on type.
 */
export async function cloneTemplate(url: string): Promise<Object3D> {
  const tpl = await loadTemplate(url);
  return skeletonClone(tpl.scene);
}

/**
 * Clone + the template's animation clips. Clips are shared (not cloned) —
 * AnimationMixer binds them to the cloned root at construction time, so
 * the same AnimationClip can drive many independent mixers.
 */
export async function cloneWithAnimations(
  url: string,
): Promise<{ scene: Object3D; animations: AnimationClip[] }> {
  const tpl = await loadTemplate(url);
  return { scene: skeletonClone(tpl.scene), animations: tpl.animations };
}

/**
 * Cached bbox extent for a loaded template, in the model's native units.
 * Resolves only after the template itself has loaded. Callers use this to
 * fit a model into a footprint without measuring each clone individually.
 */
export async function templateExtent(url: string): Promise<Vector3> {
  const cached = extents.get(url);
  if (cached) return cached;
  await measureTemplate(url);
  // biome-ignore lint/style/noNonNullAssertion: measureTemplate populated it
  return extents.get(url)!;
}

/**
 * Cached bbox center of a loaded template (native units). Non-zero when the
 * GLB ships geometry offset from the scene origin — subtract (center * scale)
 * from the placement position to keep the rendered mesh over the desired
 * world location.
 */
export async function templateCenter(url: string): Promise<Vector3> {
  const cached = centers.get(url);
  if (cached) return cached;
  await measureTemplate(url);
  // biome-ignore lint/style/noNonNullAssertion: measureTemplate populated it
  return centers.get(url)!;
}

async function measureTemplate(url: string): Promise<void> {
  const tpl = await loadTemplate(url);
  const box = new Box3().setFromObject(tpl.scene);
  const size = new Vector3();
  box.getSize(size);
  const center = new Vector3();
  box.getCenter(center);
  extents.set(url, size);
  centers.set(url, center);
}

/**
 * Fire-and-forget preload — useful when we know a set of URLs will be
 * needed soon (every building the current world references) and want to
 * front-load network cost before the first render.
 */
export function preload(urls: readonly string[]): void {
  for (const url of urls) void loadTemplate(url);
}
