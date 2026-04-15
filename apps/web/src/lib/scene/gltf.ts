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
  const tpl = await loadTemplate(url);
  const size = new Vector3();
  new Box3().setFromObject(tpl.scene).getSize(size);
  extents.set(url, size);
  return size;
}

/**
 * Fire-and-forget preload — useful when we know a set of URLs will be
 * needed soon (every building the current world references) and want to
 * front-load network cost before the first render.
 */
export function preload(urls: readonly string[]): void {
  for (const url of urls) void loadTemplate(url);
}
