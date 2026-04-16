<!--
  Sky — procedural atmospheric skybox.

  Thin wrapper around three's Preetham-model Sky shader
  (three/examples/jsm/objects/Sky.js). A giant inside-out BoxGeometry
  with a scattering shader — renders the sun disc + halo natively, so
  callers don't need a separate sun mesh.

  Uniform surface matches the threejs.org example (turbidity / rayleigh
  / mie* / elevation / azimuth). Our three version (0.169) doesn't have
  the newer cloud/time uniforms; procedural clouds stay in
  Weather.svelte.

  Why not SkyMesh? We tried. SkyMesh is the newer TSL/NodeMaterial port
  of the same math — in three r175+ it's a clean win (WebGPU-ready,
  clip-space depth trick). In 0.169 NodeMaterial is still WebGPU-first
  and misbehaves under the WebGLRenderer Threlte uses, blanking the
  scene. Classic GLSL Sky is stable here.

  Scale + camera far interplay:
    Sky is a real box of side `scale`. For the inside to render the
    camera must sit inside it AND the box must fit within the active
    camera's far plane. Scene geometry is ~maxDim units; we size the
    sky generous multiples of maxDim so it clearly feels "infinite"
    without bumping far absurdly high (z-buffer precision).
-->
<script lang="ts">
  import { T } from '@threlte/core';
  import { MathUtils, Vector3 } from 'three';
  import { Sky } from 'three/examples/jsm/objects/Sky.js';

  interface Props {
    turbidity?: number;
    rayleigh?: number;
    mieCoefficient?: number;
    mieDirectionalG?: number;
    // Degrees above horizon. 0 = sunset / sunrise, 90 = zenith.
    elevation?: number;
    // Degrees around the compass. Matches three.js example convention.
    azimuth?: number;
    // Box size in world units. Must be smaller than camera.far.
    scale?: number;
  }

  let {
    turbidity = 10,
    rayleigh = 3,
    mieCoefficient = 0.005,
    mieDirectionalG = 0.7,
    elevation = 2,
    azimuth = 180,
    scale = 10000,
  }: Props = $props();

  // Single Sky instance reused across prop changes — the shader is
  // parameterised via uniforms, there's no need to reconstruct it.
  const sky = new Sky();
  const sun = new Vector3();

  $effect(() => {
    sky.scale.setScalar(scale);
    const u = sky.material.uniforms;
    u.turbidity.value = turbidity;
    u.rayleigh.value = rayleigh;
    u.mieCoefficient.value = mieCoefficient;
    u.mieDirectionalG.value = mieDirectionalG;
    const phi = MathUtils.degToRad(90 - elevation);
    const theta = MathUtils.degToRad(azimuth);
    sun.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(sun);
  });
</script>

<T is={sky} />
